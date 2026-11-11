// Prints the base64url Ed25519 public key for RECOUNT_COLLECTOR_SIGNING_KEY, the value the
// ingestion service trusts through RECOUNT_INGESTION_COLLECTOR_PUBLIC_KEYS.
import { readSigningKey } from "../src/collectors/tokens.server";

console.log(readSigningKey().publicJwk.x);
