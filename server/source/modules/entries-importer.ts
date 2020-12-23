import { AsyncDisposer, disposeAsync } from '@tstdl/base/disposable';
import { AsyncEnumerable } from '@tstdl/base/enumerable';
import { Logger } from '@tstdl/base/logger';
import { cancelableTimeout } from '@tstdl/base/utils';
import { CancellationToken } from '@tstdl/base/utils/cancellation-token';
import { Module, ModuleBase, ModuleMetricType } from '@tstdl/server/module';
import { EntrySource } from '../entry-source';
import { EntryRepository } from '../repositories';

export class EntriesImporterModule extends ModuleBase implements Module {
  private readonly entryRepository: EntryRepository;
  private readonly logger: Logger;
  private readonly sources: EntrySource[];

  private importedEntriesCount: number;

  readonly metrics = {
    importedEntriesCount: {
      type: ModuleMetricType.Counter,
      getValue: () => this.importedEntriesCount // eslint-disable-line no-invalid-this
    }
  };

  constructor(entryRepository: EntryRepository, logger: Logger, sources: EntrySource[]) {
    super('EntriesImporter');

    this.entryRepository = entryRepository;
    this.logger = logger;
    this.sources = sources;

    this.importedEntriesCount = 0;
  }

  protected async _run(_cancellationToken: CancellationToken): Promise<void> {
    if (this.sources.length == 0) {
      throw new Error('no source available');
    }

    const disposer = new AsyncDisposer();

    await disposer.defer(async () => {
      const promises = this.sources.map(async (source) => this.import(source));
      await Promise.all(promises);
    });

    await disposer[disposeAsync]();
  }

  private async import(source: EntrySource): Promise<void> {
    const entries = source.getEntries(this.cancellationToken);

    await AsyncEnumerable.from(entries)
      .retry(false, async (error) => {
        this.logger.error(error);
        await cancelableTimeout(1000, this.cancellationToken);
        return !this.cancellationToken.isSet;
      })
      .forEach(async (batch) => {
        await this.entryRepository.saveMany(batch);
        this.importedEntriesCount += batch.length;
      });
  }
}
