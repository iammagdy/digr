import { beforeAll } from "vitest";
import { setModelPlanningForTests } from "../../src/lib/agentMission/testSeam";

/** PR B: the shared test setup. Tests that drive the engine, settlement and restarts through a fake model transcript keep working (see agent/src/testSeam.ts); the tests of the social gate itself turn it off. */
beforeAll(() => { setModelPlanningForTests(true); });
