import fs from 'fs';
import lineReader from 'line-reader';
import { IPC } from './IPC';
import { getRedisClient, initializeRedis } from './Redis';
import { formatPercent } from './utils';

const ipc = new IPC(process);

function handleError(err) {
  ipc.send('error', err.message);
  setTimeout(() => process.exit(0), 500);
}

ipc.on('parseFilmliste', async (options) => {
  await initializeRedis();
  parseFilmliste(options.file, options.setKey, options.timestampKey);
});

function createUrlFromBase(baseUrl, newUrl) {
  const newSplit = newUrl.split('|');
  if (newSplit.length == 2) {
    return baseUrl.substr(0, newSplit[0]) + newSplit[1];
  }
  return '';
}

const handleListMeta = (line: string) => {
  const regex = /".*?","(\d+)\.(\d+)\.(\d+),\s?(\d+):(\d+)"/;
  const match = regex.exec(line);
  return Math.floor(
    Date.UTC(
      parseInt(match[3]),
      parseInt(match[2]) - 1,
      parseInt(match[1]),
      parseInt(match[4]),
      parseInt(match[5])
    ) / 1000
  );
}

const mapListLineToRedis = ({ line, currentChannel, currentTopic }) => {
  // destruct parsed
  const [
    line_channel,    // 0
    line_topic,      // 1
    title,           // 2
    ,                // 3
    ,                // 4
    hr_duration,     // 5
    size,            // 6
    description,     // 7
    url_video,       // 8
    url_website,     // 9
    url_subtitle,    // 10
    ,                // 11
    url_video_low,   // 12
    ,                // 13
    url_video_hd,    // 14
    ,                // 15
    timestamp        // 16
  ] = JSON.parse(line);

  currentChannel = (line_channel.length == 0) ? currentChannel : line_channel;
  currentTopic = (line_topic.length == 0) ? currentTopic : line_topic;

  const duration = hr_duration.split(':').reverse().reduce((a, b, index) => (
    (index === 1)
      ? parseInt(a) + parseInt(b) * 60
      : parseInt(b) * (Math.pow(60, index)) + a
  ));

  return [
    currentChannel,
    currentTopic,
    {
      channel: currentChannel,
      topic: currentTopic,
      title,
      description,
      timestamp: parseInt(timestamp) | 0,
      duration,
      size: parseInt(size) * 1024 * 1024, //MB to bytes
      url_website,
      url_subtitle,
      url_video,
      url_video_low: createUrlFromBase(url_video, url_video_low),
      url_video_hd: createUrlFromBase(url_video, url_video_hd)
    }
  ]
}

function parseFilmliste(file, setKey, timestampKey) {
  const redis = getRedisClient();

  fs.open(file, 'r', (err, fd) => {
    if (err) {
      handleError(err);
      return;
    }

    fs.fstat(fd, (err, stats) => {
      if (err) {
        handleError(err);
        return;
      }

      let currentChannel,
        currentTopic,
        entry,
        buffer = [],
        currentLine = 0;

      const filesize = stats.size,
        fileStream = fs.createReadStream(null, { fd: fd, autoClose: true }),
        lineReaderSeparator = { separator: /^{"Filmliste":|,"X":|}$/ }

      const getProgress = () => {
        return fileStream.bytesRead / filesize;
      };

      lineReader.eachLine(fileStream as any, lineReaderSeparator, (line, last, getNext) => {
        currentLine++;
        if (currentLine === 1) {
          return getNext();
        }
        if (currentLine === 2) {
          redis.set(timestampKey, handleListMeta(line).toString());
          return getNext();
        }

        if (last) {
          const promises = buffer.map((jsonEntry) => redis.sAdd(setKey, jsonEntry));
          buffer = [];
          Promise.all(promises).catch((error) => console.error(error)).then(() => {
            ipc.send('state', {
              entries: currentLine - 2,
              progress: 1
            });
            ipc.send('done');
            fs.close(fd, () => setTimeout(() => process.exit(0), 500));
          });

          return;
        }

        [currentChannel, currentTopic, entry] = mapListLineToRedis({ line, currentChannel, currentTopic });

        const blacklisted = entry.title == 'Wir haben genug - Wirtschaft ohne Wachstum';

        if (!blacklisted) {
          const jsonEntry = JSON.stringify(entry);
          buffer.push(jsonEntry);
        }

        if (currentLine % 500 == 0) {
          const promises = buffer.map((jsonEntry) => redis.sAdd(setKey, jsonEntry));
          Promise.all(promises).catch((error) => console.error(error));
          buffer = [];

          ipc.send('state', {
            entries: currentLine - 2,
            progress: formatPercent(getProgress())
          });
        }
        getNext();
      });
    });
  });
}
