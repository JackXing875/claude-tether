import { writeFileSync } from 'node:fs';
import { OperationJournal } from '../../packages/operation-journal/index.js';
import type { Operation } from '../../packages/protocol/index.js';

const [database, target, serialized] = process.argv.slice(2);
const operation = JSON.parse(serialized!) as Operation;
const journal = new OperationJournal(database!);
journal.accept(operation);
journal.setState(operation.operation_id, 'RUNNING');
writeFileSync(target!, 'effect already happened');
// Emulate a hard crash between an external effect and the durable result.
process.exit(17);
