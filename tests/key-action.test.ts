import assert from "node:assert/strict";
import { test } from "node:test";

import { ReadOnlyKeyAction } from "../src/actions/key-action.ts";

class TestAction extends ReadOnlyKeyAction {}

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((accept, fail) => {
		resolve = accept;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("image writes are serial and finish on the latest desired image", async () => {
	let desired = "first";
	const first = deferred();
	const writes: string[] = [];
	const action = {
		id: "key",
		isKey: () => true,
		setImage: (image: string) => {
			writes.push(image);
			return image === "first" ? first.promise : Promise.resolve();
		},
	};
	const subject = new TestAction(() => desired);

	subject.onWillAppear({ action } as never);
	desired = "second";
	subject.onWillAppear({ action } as never);
	assert.deepEqual(writes, ["first"]);

	first.resolve();
	await flush();
	assert.deepEqual(writes, ["first", "second"]);
});

test("a failed image write is retried by the next render", async () => {
	let attempts = 0;
	const action = {
		id: "key",
		isKey: () => true,
		setImage: () => {
			attempts++;
			return attempts === 1 ? Promise.reject(new Error("write failed")) : Promise.resolve();
		},
	};
	const subject = new TestAction(() => "image");

	subject.onWillAppear({ action } as never);
	await flush();
	assert.equal(attempts, 1);

	subject.onWillAppear({ action } as never);
	await flush();
	assert.equal(attempts, 2);
});
