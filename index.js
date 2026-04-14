const { onRequest } = require("firebase-functions/v2/https");
const { createApiApp } = require("./app");

const app = createApiApp();

exports.api = onRequest(
  {
    region: "us-central1",
    invoker: "public",
  },
  app
);
