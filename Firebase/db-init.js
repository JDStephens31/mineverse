let admin = require("firebase-admin");
let serviceAccount = require("./admin-sdk.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
module.exports = db;