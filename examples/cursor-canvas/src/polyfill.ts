// web3.js expects node's Buffer; must be installed before any web3 import runs.
import { Buffer } from "buffer";

(globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
