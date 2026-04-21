import { out, sleep } from "./shared.ts";

for (let step = 1; step <= 4; step += 1) {
  out(`sync batch ${step}/4 complete`);
  await sleep(1000);
}
