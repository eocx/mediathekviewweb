import { TermQuery } from '../../../../common/search-engine/query';
import { ConvertHandler, ConvertResult } from '../convert-handler';

type ElasticsearchTermQuery = { term: StringMap<string | number | boolean | Date> };

export class TermQueryConvertHandler implements ConvertHandler {
  tryConvert(query: TermQuery, _index: string, _type: string): ConvertResult {
    const canHandle = ('term' in query);

    if (!canHandle) {
      return false;
    }

    const queryObject: ElasticsearchTermQuery = {
      term: {
        [query.term.field]: query.term.value
      }
    };

    return queryObject;
  }
}
