/** Generates an ejson keypair and stores the private key in the keydir. Prints the public key. */
import { generateKeypair } from '../src/config/ejson.js';
import { resolveKeydir, writePrivateKey } from './_shared.js';

// Generate the keypair and save the private key.
const dir = resolveKeydir();
const kp = generateKeypair();
const file = writePrivateKey(dir, kp.publicKey, kp.privateKey);
console.log(`Public key:  ${kp.publicKey}`);
console.log(`Private key: written to ${file} (mode 0400). Back it up offline — losing it loses the vault.`);
