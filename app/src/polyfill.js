// Must be the FIRST import of the entry module. ESM hoisting evaluates imported
// modules before any entry-file statements run, and chain.js constructs an Anchor
// Program at module scope, which needs Buffer already on the global.
import { Buffer } from "buffer";

globalThis.Buffer = Buffer;
