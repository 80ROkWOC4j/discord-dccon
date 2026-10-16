import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import {createConfigStore as createFileStore} from './file-store.ts';
import {createStorageEnvironment} from './runtime.ts';
import type {StoreOptions, Migrations} from './types.ts';

export function createConfigStore(options: StoreOptions, migrations?: Migrations) {
  return createFileStore(options, createStorageEnvironment({path, crypto, fs}), migrations);
}
