import assert from "node:assert/strict";
import test from "node:test";

import { decideInboxAuthentication, isLoopbackRemoteAddress } from "../local-agent/inbox-auth.mjs";

const allowedOrigins = ["http://localhost:3000", "https://filehelper.weixin.qq.com"];

test("configured inbox secret always selects signature authentication", () => {
  assert.equal(decideInboxAuthentication({
    hasSecret: true,
    allowedOrigins,
    origin: "",
    remoteAddress: "127.0.0.1",
  }), "signature");
  assert.equal(decideInboxAuthentication({
    hasSecret: true,
    allowedOrigins,
    origin: "http://localhost:3000",
    remoteAddress: "127.0.0.1",
  }), "signature");
});

test("without a secret, exact allowed Origin or an Origin-less loopback socket is accepted", () => {
  assert.equal(decideInboxAuthentication({
    hasSecret: false,
    allowedOrigins,
    origin: "https://filehelper.weixin.qq.com",
    remoteAddress: "203.0.113.8",
  }), "origin");
  for (const remoteAddress of ["127.0.0.1", "127.42.0.7", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(decideInboxAuthentication({
      hasSecret: false,
      allowedOrigins,
      origin: "",
      remoteAddress,
    }), "loopback");
    assert.equal(isLoopbackRemoteAddress(remoteAddress), true);
  }
});

test("bad Origin and Origin-less non-loopback sockets are denied", () => {
  assert.equal(decideInboxAuthentication({
    hasSecret: false,
    allowedOrigins,
    origin: "https://attacker.example",
    remoteAddress: "127.0.0.1",
  }), "deny", "an explicit bad Origin must not fall back to loopback trust");
  assert.equal(decideInboxAuthentication({
    hasSecret: false,
    allowedOrigins,
    origin: "",
    remoteAddress: "192.0.2.25",
  }), "deny");
  assert.equal(decideInboxAuthentication({
    hasSecret: true,
    allowedOrigins,
    origin: "https://attacker.example",
    remoteAddress: "127.0.0.1",
  }), "deny", "a valid signature never overrides an explicit bad Origin");
  assert.equal(decideInboxAuthentication({
    hasSecret: false,
    allowedOrigins,
    origin: ["http://localhost:3000"],
    remoteAddress: "127.0.0.1",
  }), "deny", "ambiguous Origin headers fail closed");
  assert.equal(isLoopbackRemoteAddress("::ffff:192.168.1.8"), false);
});
