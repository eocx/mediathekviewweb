import { IDatastoreProvider, IKey, IMap, ISortedSet, ISet } from '../data-store';
import { DatastoreKeys } from '../data-store-keys';
import { Entry } from '../common/model';
import config from '../config';
import { random } from '../common/utils';
import * as Bull from 'bull';
import { ILockProvider, ILock } from '../lock';
import { DistributedLoop } from '../distributed-loop';
import { QueueProvider, IndexEntriesType } from '../queue';
import { SearchEngine, SearchEngineItem } from '../common/search-engine';

const BATCH_SIZE = 100;

export class EntriesIndexer {
  private indexEntriesQueue: Bull.Queue;
  private entryMap: IMap<Entry>;

  constructor(private datastoreProvider: IDatastoreProvider, private searchEngine: SearchEngine<Entry>, private queueProvider: QueueProvider) {
    this.indexEntriesQueue = queueProvider.getIndexEntriesQueue();
    this.entryMap = datastoreProvider.getMap(DatastoreKeys.EntryMap);
  }

  run() {
    this.indexEntriesQueue.process(1, (job) => this.process(job));
  }

  private async process(job: Bull.Job) {
    const data: IndexEntriesType = job.data;

    console.log(job.id, job.data);

    const idsSet = this.datastoreProvider.getSet<string>(data.idsSetKey);

    let left = data.amount;

    while (left > 0) {
      const entryIDs = await idsSet.pop(BATCH_SIZE);
      left -= BATCH_SIZE;

      const result = await this.entryMap.getMany(...entryIDs);
      const entries = result.filter((r) => r != null).map((r) => r.value as Entry);

      await this.index(entries);
    }
  }

  private async index(entries: Entry[]) {
    const searchEngineEntries: SearchEngineItem<Entry>[] = [];

    for (const entry of entries) {
      const searchEngineEntry: SearchEngineItem<Entry> = {
        id: entry.id,
        document: entry
      }

      searchEngineEntries.push(searchEngineEntry);
    }

    await this.searchEngine.index(...searchEngineEntries);
  }
}
