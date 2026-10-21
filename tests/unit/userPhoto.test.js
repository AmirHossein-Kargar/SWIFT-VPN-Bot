import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

process.env.ADMINS = "9001";
const { getUserProfilePhoto, pickPhotoSize, clearUserPhotoCacheForTests, PHOTO_MAX_BYTES } = await import("../../services/admin/userPhoto.js");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const users = new Set(["1001"]);
const userModel = { async exists({ telegramId }) { return users.has(telegramId) ? { _id: 1 } : null; } };

let calls;
function makeBot({ photos, bytes = JPEG, failPhotos = false, failStream = false } = {}) {
  calls = { photos: 0, stream: 0 };
  return {
    async getUserProfilePhotos() {
      calls.photos += 1;
      if (failPhotos) throw new Error("ETELEGRAM: 429");
      return { total_count: photos?.length ?? 0, photos: photos ?? [] };
    },
    getFileStream() {
      calls.stream += 1;
      if (failStream) return Readable.from((async function* () { throw new Error("file expired"); })());
      return Readable.from([bytes]);
    },
  };
}
const SIZES = [[{ file_id: "small", file_unique_id: "U1", width: 64 }, { file_id: "mid", file_unique_id: "U2", width: 160 }, { file_id: "big", file_unique_id: "U3", width: 640 }]];
const ask = (extra) => getUserProfilePhoto({ actorId: "9001", telegramId: "1001", userModel, ...extra });

beforeEach(() => clearUserPhotoCacheForTests());

describe("profile photo retrieval", () => {
  test("returns image bytes with a sniffed content type and a stable ETag", async () => {
    const result = await ask({ bot: makeBot({ photos: SIZES }) });
    assert.equal(result.status, "ok");
    assert.equal(result.contentType, "image/jpeg");
    assert.equal(result.etag, '"tg-U2"');
    assert.ok(result.body.equals(JPEG));
  });

  test("picks the smallest sharp rendition, else the largest", () => {
    assert.equal(pickPhotoSize(SIZES[0]).file_id, "mid");
    assert.equal(pickPhotoSize([{ file_id: "a", width: 40 }, { file_id: "b", width: 90 }]).file_id, "b");
    assert.equal(pickPhotoSize([]), null);
  });

  test("only admins may fetch; unknown users are refused before Telegram is contacted", async () => {
    const bot = makeBot({ photos: SIZES });
    await assert.rejects(() => getUserProfilePhoto({ actorId: "5", telegramId: "1001", userModel, bot }), { code: "forbidden" });
    await assert.rejects(() => ask({ bot, telegramId: "424242" }), { code: "user_not_found" });
    await assert.rejects(() => ask({ bot, telegramId: "../etc" }), { code: "invalid_user_id" });
    assert.equal(calls.photos, 0);
  });

  test("a user without a photo is a normal 'none' outcome and is cached", async () => {
    const bot = makeBot({ photos: [] });
    assert.equal((await ask({ bot })).status, "none");
    assert.equal((await ask({ bot })).status, "none");
    assert.equal(calls.photos, 1);
  });

  test("a matching If-None-Match answers not_modified without downloading", async () => {
    const bot = makeBot({ photos: SIZES });
    await ask({ bot });
    const streamsBefore = calls.stream;
    const again = await ask({ bot, ifNoneMatch: '"tg-U2"' });
    assert.equal(again.status, "not_modified");
    assert.equal(calls.stream, streamsBefore);
  });

  test("Telegram failures degrade to 'unavailable' and the next call re-resolves", async () => {
    assert.equal((await ask({ bot: makeBot({ failPhotos: true }) })).status, "unavailable");
    assert.equal((await ask({ bot: makeBot({ photos: SIZES, failStream: true }) })).status, "unavailable");
    assert.equal((await ask({ bot: makeBot({ photos: SIZES }) })).status, "ok");
  });

  test("bytes that are not a known image type are never relayed", async () => {
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    assert.equal((await ask({ bot: makeBot({ photos: SIZES, bytes: html }) })).status, "unavailable");
  });

  test("oversized downloads are refused", async () => {
    const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(PHOTO_MAX_BYTES + 10)]);
    assert.equal((await ask({ bot: makeBot({ photos: SIZES, bytes: huge }) })).status, "unavailable");
  });

  test("no bot available (e.g. polling not started) is 'unavailable', not a crash", async () => {
    assert.equal((await ask({ bot: null })).status, "unavailable");
  });

  test("the result never contains the Telegram file path, file id or token", async () => {
    const result = await ask({ bot: makeBot({ photos: SIZES }) });
    assert.deepEqual(Object.keys(result).sort(), ["body", "contentType", "etag", "status"]);
  });
});
