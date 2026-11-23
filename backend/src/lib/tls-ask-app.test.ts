import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askApp, tlsAskPath, tlsAskRequestPath, type StatusRequester } from "./tls-ask-app.js";

const svar = (status: number): StatusRequester => async () => status;

describe("tlsAskPath", () => {
  it("leser stien fra miljøvariabelen", () => {
    assert.equal(tlsAskPath({ SNOAT_TLS_ASK_PATH: "/api/infra/domain-check" }), "/api/infra/domain-check");
    assert.equal(tlsAskPath({ SNOAT_TLS_ASK_PATH: "  /tls  " }), "/tls");
  });

  it("er av når variabelen mangler eller er tom", () => {
    assert.equal(tlsAskPath(null), null);
    assert.equal(tlsAskPath({}), null);
    assert.equal(tlsAskPath({ SNOAT_TLS_ASK_PATH: " " }), null);
  });

  it("avviser alt som kan sende kallet til en annen vert", () => {
    assert.equal(tlsAskPath({ SNOAT_TLS_ASK_PATH: "http://evil.example/x" }), null);
    assert.equal(tlsAskPath({ SNOAT_TLS_ASK_PATH: "//evil.example/x" }), null);
    assert.equal(tlsAskPath({ SNOAT_TLS_ASK_PATH: "@evil.example/x" }), null);
    assert.equal(tlsAskPath({ SNOAT_TLS_ASK_PATH: "/x?domain=a" }), null);
  });
});

describe("tlsAskRequestPath", () => {
  it("koder domenet", () => {
    assert.equal(
      tlsAskRequestPath("/api/infra/domain-check", "vel.mittvel.no"),
      "/api/infra/domain-check?domain=vel.mittvel.no",
    );
    assert.equal(tlsAskRequestPath("/t", "a&b"), "/t?domain=a%26b");
  });

  it("sender foreldredomenet som vert", async () => {
    let sett = "";
    await askApp("mittvel.no", "/t", "vel.mittvel.no", async (host) => {
      sett = host;
      return 200;
    });
    assert.equal(sett, "mittvel.no");
  });
});

describe("askApp", () => {
  it("2xx er ja", async () => {
    assert.equal(await askApp("b.no", "/t", "a.b.no", svar(200)), "ja");
  });

  it("4xx er nei", async () => {
    assert.equal(await askApp("b.no", "/t", "a.b.no", svar(404)), "nei");
  });

  it("5xx, omdirigering og nettverksfeil er feil", async () => {
    assert.equal(await askApp("b.no", "/t", "a.b.no", svar(503)), "feil");
    assert.equal(await askApp("b.no", "/t", "a.b.no", svar(302)), "feil");
    const kaster: StatusRequester = async () => {
      throw new Error("ECONNREFUSED");
    };
    assert.equal(await askApp("b.no", "/t", "a.b.no", kaster), "feil");
  });

});
