/**
 * Test seam for suites that run without MongoDB but exercise purchase authorization (which refuses to use the
 * shipped fallback when the catalog database is unreachable). Installs an empty in-memory product collection, which
 * the catalog code treats as "nothing customised: sell the shipped plans".
 */
import { setProductModelForTests } from "../../services/plans.js";

const emptyQuery = (value) => ({ sort() { return this; }, lean: () => Promise.resolve(value), then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } });

export function useShippedCatalog() {
  setProductModelForTests({
    find: () => emptyQuery([]),
    findOne: () => emptyQuery(null),
    countDocuments: () => Promise.resolve(0),
  });
}

export function resetCatalog() {
  setProductModelForTests(null);
}
