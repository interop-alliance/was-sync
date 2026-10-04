/**
 * A module that imports `rxdb`, loaded by the smoke test to show the dev
 * server really refuses the package. If this module loads, the smoke test's
 * "no rxdb" claim would hold for any root entry, rxdb-free or not.
 */
import 'rxdb/plugins/core'
