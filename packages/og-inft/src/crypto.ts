/**
 * Encryption + sealed-key primitives for the iNFT pipeline.
 *
 *   - Bundle encryption: AES-256-GCM with a fresh random key.
 *   - Sealed key: ECIES over secp256k1. The recipient is identified by their
 *     EVM address — we look up their *uncompressed* public key from a
 *     known signature (or a registration step). For the hackathon we let
 *     callers pass the recipient pubkey directly; transfer.ts derives it
 *     from a one-time sign-in signature.
 *
 * Wire format (all hex unless noted):
 *
 *     sealedKey = 0x04 || ephPubX (32) || ephPubY (32) || iv (12)
 *                  || ciphertext (32 — the AES-GCM key) || tag (16)
 *                = 1 + 32 + 32 + 12 + 32 + 16 = 125 bytes
 *
 * The on-chain INFT7857 stores `sealedKey` as opaque bytes; the wire format
 * lives in this module. Rotating the format is a coordinated migration.
 */

import { gcm } from '@noble/ciphers/aes';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { randomBytes } from 'node:crypto';

const HKDF_INFO = new TextEncoder().encode('federated-reserve/og-inft/v1');
const SEALED_PREFIX_LEN = 1 + 32 + 32 + 12; // ephPub uncompressed + iv

export interface BundleCipher {
  /** Wire blob to upload to 0G Storage: iv (12) || aes-256-gcm ciphertext. */
  blob: Uint8Array;
  /** keccak-256 of the *plaintext* bundle — the on-chain commitment. */
  plaintextDigest: Uint8Array;
  /** 32-byte AES-256-GCM key used to encrypt the bundle. Seal this under the
   *  recipient pubkey via [`sealSymmetricKey`](#sealsymmetrickey) before mint. */
  symmetricKey: Uint8Array;
}

/** Encrypt a JSON-serializable bundle with AES-256-GCM. If `symmetricKey`
 *  is supplied, reuses it (the iNFT model — the same long-lived key seals
 *  the agent's identity across all memory snapshots; only ownership transfer
 *  rotates it). Otherwise generates a fresh key.
 *
 *  The returned `blob` is `iv || ciphertext` and is what gets uploaded to
 *  0G Storage. */
export function encryptBundle(plaintext: Uint8Array, symmetricKey?: Uint8Array): BundleCipher {
  const key = symmetricKey ?? new Uint8Array(randomBytes(32));
  if (key.length !== 32) throw new Error('symmetricKey must be 32 bytes');
  const iv = new Uint8Array(randomBytes(12));
  const ciphertext = gcm(key, iv).encrypt(plaintext);
  const blob = new Uint8Array(iv.length + ciphertext.length);
  blob.set(iv, 0);
  blob.set(ciphertext, iv.length);
  const plaintextDigest = keccak_256(plaintext);
  return { blob, plaintextDigest, symmetricKey: key };
}

/** Generate a fresh 32-byte AES-256-GCM key. */
export function generateSymmetricKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

export function decryptBundle(blob: Uint8Array, symmetricKey: Uint8Array): Uint8Array {
  if (blob.length < 12 + 16) throw new Error('blob too short for iv+tag');
  const iv = blob.slice(0, 12);
  const ciphertext = blob.slice(12);
  return gcm(symmetricKey, iv).decrypt(ciphertext);
}

/**
 * Seal `symmetricKey` to a recipient's secp256k1 *uncompressed* public key
 * (65 bytes, 0x04-prefixed). Returns the wire-format sealed-key blob.
 */
export function sealSymmetricKey(
  symmetricKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array {
  if (symmetricKey.length !== 32) throw new Error('symmetricKey must be 32 bytes');
  if (recipientPublicKey.length !== 65 || recipientPublicKey[0] !== 0x04) {
    throw new Error('recipientPublicKey must be 65-byte uncompressed (0x04 prefix)');
  }

  // Ephemeral keypair.
  const ephPriv = secp256k1.utils.randomPrivateKey();
  const ephPub = secp256k1.getPublicKey(ephPriv, false); // 65-byte uncompressed

  // ECDH → shared secret → HKDF → AES-256 key.
  const shared = secp256k1.getSharedSecret(ephPriv, recipientPublicKey, true).slice(1); // strip 0x04
  const wrapKey = hkdf(sha256, shared, undefined, HKDF_INFO, 32);

  const iv = new Uint8Array(randomBytes(12));
  const wrapCipher = gcm(wrapKey, iv).encrypt(symmetricKey);
  // wrapCipher = key-ciphertext (32) || tag (16)

  const out = new Uint8Array(SEALED_PREFIX_LEN + wrapCipher.length);
  out.set(ephPub, 0);
  out.set(iv, 65);
  out.set(wrapCipher, SEALED_PREFIX_LEN);
  return out;
}

/**
 * Reverse `sealSymmetricKey`: given a recipient's secp256k1 private key
 * (32 bytes), recover the AES-256 bundle key.
 */
export function unsealSymmetricKey(
  sealedKey: Uint8Array,
  recipientPrivateKey: Uint8Array,
): Uint8Array {
  if (sealedKey.length < SEALED_PREFIX_LEN + 16) {
    throw new Error('sealedKey too short');
  }
  const ephPub = sealedKey.slice(0, 65);
  const iv = sealedKey.slice(65, SEALED_PREFIX_LEN);
  const wrapCipher = sealedKey.slice(SEALED_PREFIX_LEN);

  const shared = secp256k1.getSharedSecret(recipientPrivateKey, ephPub, true).slice(1);
  const wrapKey = hkdf(sha256, shared, undefined, HKDF_INFO, 32);
  const key = gcm(wrapKey, iv).decrypt(wrapCipher);
  if (key.length !== 32) throw new Error('unwrapped key length unexpected');
  return key;
}

/** Convert a 65-byte uncompressed pubkey to 33-byte compressed. */
export function compressPublicKey(uncompressed: Uint8Array): Uint8Array {
  return secp256k1.ProjectivePoint.fromHex(uncompressed).toRawBytes(true);
}

/** Derive the uncompressed (0x04-prefixed) pubkey from a 32-byte private key. */
export function pubkeyFromPrivate(priv: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(priv, false);
}

/** Generate a fresh secp256k1 keypair for the transfer ceremony. Returns the
 *  32-byte private key and the 65-byte uncompressed public key. */
export function generateSecpKeypair(): { privateKey: Uint8Array; publicKey: Uint8Array } {
  const privateKey = secp256k1.utils.randomPrivateKey();
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  return { privateKey, publicKey };
}
