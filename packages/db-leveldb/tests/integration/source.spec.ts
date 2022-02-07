// @ts-nocheck
import { Storage } from "../../src/storage";
import { expect } from "chai";
const os = require("os");

describe("Source", () => {
  const tmpDir = os.tmpdir();

  let databaseName = "truffledbTest";
  let databaseEngine = "memory";
  let databaseDirectory = tmpDir;

  let levelDB;
  let models: object;
  let Source;

  beforeEach(() => {
    const DB = Storage.createStorage({
      databaseEngine,
      databaseDirectory,
      databaseName
    });

    levelDB = DB.levelDB;
    models = DB.models;

    Source = models.Source;
  });
  afterEach(() => {
    levelDB.close();
  });

  it("generates an id from the content addressable fields", () => {
    expect(typeof Source).to.equal("function");
  });
  it("query");
  it("save");
  it("lookup names");
  it("enumerate resources");
});
