import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MtcuteProcessClientOwner,
} from "../src/telegram/mtcute/process-owner.js";
import {
  FakeMtcuteClient,
  config,
} from "./support/mtcute-client.js";

test("destroy serializes with timed-out connect cleanup", async () => {
  const client = new FakeMtcuteClient();
  const events: string[] = [];
  const connection = deferred<void>();
  const disconnectGate = deferred<void>();
  client.connect = async () => {
    events.push("connect");
    await connection.promise;
  };
  client.disconnect = async () => {
    events.push("disconnect-start");
    await disconnectGate.promise;
    events.push("disconnect-end");
  };
  client.destroy = async () => {
    events.push("destroy");
  };

  const owner = new MtcuteProcessClientOwner(async () => client);
  await assert.rejects(
    owner.getConnected(config({ connectionTimeoutMs: 10 })),
    /timed out/u,
  );
  await waitFor(() => events.includes("disconnect-start"));

  let destroyed = false;
  const destroyPromise = owner.destroy().then(() => {
    destroyed = true;
  });
  await delay(15);
  assert.equal(destroyed, false);
  assert.deepEqual(events, ["connect", "disconnect-start"]);

  disconnectGate.resolve();
  connection.resolve();
  await destroyPromise;
  assert.deepEqual(events, ["connect", "disconnect-start", "disconnect-end", "destroy"]);
});

test("concurrent disconnect and destroy are serialized", async () => {
  const client = new FakeMtcuteClient();
  const events: string[] = [];
  const disconnectGate = deferred<void>();
  client.connect = async () => {
    events.push("connect");
  };
  client.disconnect = async () => {
    events.push("disconnect-start");
    await disconnectGate.promise;
    events.push("disconnect-end");
  };
  client.destroy = async () => {
    events.push("destroy");
  };

  const owner = new MtcuteProcessClientOwner(async () => client);
  await owner.getConnected(config());
  const disconnectPromise = owner.disconnect();
  await waitFor(() => events.includes("disconnect-start"));
  const destroyPromise = owner.destroy();
  await delay(10);
  assert.equal(events.includes("destroy"), false);

  disconnectGate.resolve();
  await Promise.all([disconnectPromise, destroyPromise]);

  assert.deepEqual(events, ["connect", "disconnect-start", "disconnect-end", "destroy"]);
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      }
    }, 1);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
