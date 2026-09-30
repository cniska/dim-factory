const POLL_MS = 20;

export const WAIT_LIMIT_MS = 120_000;

const MACHINE_SETUP_AND_ASSERT_MS = 60_000;

export const MACHINE_TEST_LIMIT_MS = WAIT_LIMIT_MS + MACHINE_SETUP_AND_ASSERT_MS;

export async function waitFor(what: string, done: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`gave up after ${WAIT_LIMIT_MS} ms waiting for ${what}`);
    await Bun.sleep(POLL_MS);
  }
}
