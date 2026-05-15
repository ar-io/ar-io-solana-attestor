//! HTTP entry point for the ar.io ANT escrow attestor service.
//!
//! Loads the Express app from `./app.js` and starts listening. The
//! app is split out so integration tests can mount it on a random
//! port without involving this file.

import pino from "pino";

import app, { config } from "./app.js";
import bs58 from "bs58";

const log = pino({ level: config.logLevel });

app.listen(config.port, () => {
  log.info(
    {
      port: config.port,
      network: config.network,
      attestorPubkeyBase58: bs58.encode(config.attestor.publicKey),
    },
    "ar.io escrow attestor listening",
  );
});
