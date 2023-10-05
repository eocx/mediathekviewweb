import cp from 'child_process';
import Elasticsearch from 'elasticsearch';
import EventEmitter from 'events';
import { config } from './config';
import * as elasticsearchDefinitions from './ElasticsearchDefinitions';
import { IPC } from './IPC';
import { getRedisClient, RedisClient } from './Redis';
import { StateEmitter } from './StateEmitter';


export class MediathekIndexer extends EventEmitter {
  redis: RedisClient;
  searchClient: Elasticsearch.Client;
  stateEmitter: StateEmitter;

  constructor(elasticsearchOptions: Elasticsearch.ConfigOptions) {
    super();

    const configClone = JSON.parse(JSON.stringify(elasticsearchOptions));

    this.searchClient = new Elasticsearch.Client(configClone);
    this.redis = getRedisClient();
    this.stateEmitter = new StateEmitter(this);
  }

  async indexFilmliste(file): Promise<void> {
    this.stateEmitter.setState('step', 'indexFilmliste');

    return new Promise<void>((resolve, reject) => {
      this.hasCurrentState((err, hasCurrentState) => {
        if (err) {
          return reject(err);
        }

        if (hasCurrentState) {
          return this.deltaIndexFilmliste(file, (err) => {
            if (err) {
              return reject(err);
            }
            this.finalize((err) => {
              if (err) {
                return reject(err);
              }
              resolve(null);
            });
          });
        }

        this.fullIndexFilmliste(file, (err) => {
          if (err) {
            return reject(err);
          }
          this.finalize((err) => {
            if (err) {
              return reject(err);
            }
            resolve(null);
          });
        });
      });
    });
  }

  finalize(callback) {
    this.stateEmitter.setState('step', 'finalize');
    this.redis.multi()
      .rename('mediathekIndexer:newFilmliste', 'mediathekIndexer:currentFilmliste')
      .rename('mediathekIndexer:newFilmlisteTimestamp', 'mediathekIndexer:currentFilmlisteTimestamp')
      .del('mediathekIndexer:addedEntries')
      .del('mediathekIndexer:removedEntries')
      .exec()
      .then(() => callback(null))
      .catch((error) => callback(error));

    this.emit('done');
    this.stateEmitter.setState('step', 'waiting');
  }

  hasCurrentState(callback) {
    this.redis.exists('mediathekIndexer:currentFilmliste')
      .then((result) => callback(null, result))
      .catch((error) => callback(error, null));
  }

  fullIndexFilmliste(file, callback) {
    this.stateEmitter.setState('step', 'fullIndexFilmliste');
    this.reCreateESIndex((err) => {
      if (err) {
        return callback(err);
      }
      this.parseFilmliste(file, 'mediathekIndexer:newFilmliste', 'mediathekIndexer:newFilmlisteTimestamp', (err) => {
        if (err) {
          return callback(err);
        }
        this.createDelta('mediathekIndexer:newFilmliste', 'mediathekIndexer:none', (err) => {
          if (err) {
            return callback(err);
          }
          this.indexDelta((err) => {
            if (err) {
              return callback(err);
            }
            callback(null);
          });
        });
      });
    });
  }

  reCreateESIndex(callback) {
    this.stateEmitter.setState('step', 'reCreateESIndex');
    this.searchClient.indices.delete({
      index: 'filmliste'
    }, (err, resp, status) => {
      if (err && err.status != 404) { //404 (index not found) is fine, as we'll create the index in next step.
        return callback(err);
      }
      this.searchClient.indices.create({
        index: 'filmliste'
      }, (err, resp, status) => {
        if (err) {
          return callback(err);
        }
        this.searchClient.indices.close({
          index: 'filmliste'
        }, (err, resp, status) => {
          if (err) {
            return callback(err);
          }
          this.searchClient.indices.putSettings({
            index: 'filmliste',
            body: elasticsearchDefinitions.settings
          }, (err, resp, status) => {
            if (err) {
              return callback(err);
            }
            this.searchClient.indices.putMapping({
              index: 'filmliste',
              type: 'entries',
              body: elasticsearchDefinitions.mapping
            }, (err, resp, status) => {
              if (err) {
                return callback(err);
              }
              this.searchClient.indices.open({
                index: 'filmliste'
              }, (err, resp, status) => {
                if (err) {
                  return callback(err);
                }
                callback(null);
              });
            });
          });
        });
      });
    });
  }

  deltaIndexFilmliste(file, callback) {
    this.stateEmitter.setState('step', 'deltaIndexFilmliste');
    this.parseFilmliste(file, 'mediathekIndexer:newFilmliste', 'mediathekIndexer:newFilmlisteTimestamp', (err) => {
      if (err) {
        return callback(err);
      }
      this.createDelta('mediathekIndexer:newFilmliste', 'mediathekIndexer:currentFilmliste', (err) => {
        if (err) {
          return callback(err);
        }
        this.indexDelta((err) => {
          if (err) {
            return callback(err);
          }
          callback(null);
        });
      });
    });
  }

  async createDelta(newSet, currentSet, callback) {
    this.stateEmitter.setState('step', 'createDelta');

    const [, , added, removed] = await this.redis.multi()
      .sDiffStore('mediathekIndexer:addedEntries', [newSet, currentSet])
      .sDiffStore('mediathekIndexer:removedEntries', [currentSet, newSet])
      .sCard('mediathekIndexer:addedEntries')
      .sCard('mediathekIndexer:removedEntries')
      .exec()
      .catch((error) => callback(error));

    this.stateEmitter.updateState({ added, removed });

    callback(null);
  }

  combineWorkerStates(workerStates) {
    let addedEntries = 0,
      removedEntries = 0;

    for (let i = 0; i < workerStates.length; i++) {
      if (workerStates[i] != undefined) {
        addedEntries += workerStates[i].addedEntries;
        removedEntries += workerStates[i].removedEntries;
      }
    }

    return {
      addedEntries: addedEntries,
      removedEntries: removedEntries
    };
  }

  indexDelta(callback) {
    this.stateEmitter.setState('step', 'indexDelta');

    let indexerWorkers: cp.ChildProcess[] = [];
    let indexerWorkersState = [];

    let workersDone = 0;
    let lastStatsUpdate = 0;

    for (let i = 0; i < config.workerCount; i++) {
      let indexerWorker = cp.fork(__dirname + '/MediathekIndexerWorker.js', [], { execArgv: config.workerArgs });

      indexerWorkers[i] = indexerWorker;

      let ipc = new IPC(indexerWorker);

      ipc.on('state', (state) => {
        indexerWorkersState[i] = state;

        if ((Date.now() - lastStatsUpdate) > 500) { //wait atleast 500ms
          this.stateEmitter.updateState(this.combineWorkerStates(indexerWorkersState));
          lastStatsUpdate = Date.now();
        }
      });
      ipc.on('done', () => {
        workersDone++;

        if (workersDone == config.workerCount) {
          this.stateEmitter.updateState(this.combineWorkerStates(indexerWorkersState));
          callback(null);
        }
      });
      ipc.on('error', (err) => {
        callback(new Error(err));
      });
    }
  }

  parseFilmliste(file, setKey, timestampKey, callback) {
    this.stateEmitter.setState('step', 'parseFilmliste');
    let filmlisteParser = cp.fork(__dirname + '/FilmlisteParser.js', [], { execArgv: config.workerArgs });

    let ipc = new IPC(filmlisteParser);

    ipc.on('error', (errMessage) => {
      callback(new Error(errMessage));
    });

    let lastState = null;
    let lastStatsUpdate = 0;

    ipc.on('state', (state) => {
      lastState = state;

      if ((Date.now() - lastStatsUpdate) > 500) { //wait atleast 500ms
        this.stateEmitter.updateState(lastState);
        lastStatsUpdate = Date.now();
      }
    });

    ipc.on('done', () => {
      this.stateEmitter.updateState(lastState);
      callback(null);
    });

    ipc.send('parseFilmliste', {
      file: file,
      setKey: setKey,
      timestampKey: timestampKey
    });
  }
}
