/* tslint:disable */
/* eslint-disable */
export class BrowserClient {
  free(): void;
  add_member(bytes: Uint8Array): string;
  key_package(): Uint8Array;
  create_group(id: string): void;
  process_from(bytes: Uint8Array, sender: string): string;
  remove_member(identity: string): Uint8Array;
  constructor(identity: string);
  join(welcome: Uint8Array): void;
  encrypt(bytes: Uint8Array): Uint8Array;
  process(bytes: Uint8Array): string;
  static restore(bytes: Uint8Array): BrowserClient;
  describe(): string;
  snapshot(): Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_browserclient_free: (a: number, b: number) => void;
  readonly browserclient_add_member: (a: number, b: number, c: number) => [number, number, number, number];
  readonly browserclient_create_group: (a: number, b: number, c: number) => [number, number];
  readonly browserclient_describe: (a: number) => [number, number, number, number];
  readonly browserclient_encrypt: (a: number, b: number, c: number) => [number, number, number, number];
  readonly browserclient_join: (a: number, b: number, c: number) => [number, number];
  readonly browserclient_key_package: (a: number) => [number, number, number, number];
  readonly browserclient_new: (a: number, b: number) => [number, number, number];
  readonly browserclient_process: (a: number, b: number, c: number) => [number, number, number, number];
  readonly browserclient_process_from: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
  readonly browserclient_remove_member: (a: number, b: number, c: number) => [number, number, number, number];
  readonly browserclient_restore: (a: number, b: number) => [number, number, number];
  readonly browserclient_snapshot: (a: number) => [number, number, number, number];
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
