/**
 * TEST-ONLY SEAM (PR B, round 18). The model-planned social pipeline is deleted: in production a social request is planned by the plan compiler or not offered, and a social plan proposed by the model is refused.
 * The engine, settlement, restart and money tests drive a whole mission through a FAKE model transcript whose requests happen to be social; they test the platform-agnostic engine, not social planning. While this switch is on
 * (only tests/setup/legacyModelPlanning.ts turns it on, for every test file; the approval guard of staleSocialPlan.ts steps aside too) the social gate and the social-plan refusal step aside so those tests keep running exactly the behaviour they always tested.
 * Production never calls the setter (tests/round18-one-social-path.test.ts reads every source file to prove it); off, nothing here changes anything.
 */
let modelPlanning = false;
export const modelPlanningForTests = (): boolean => modelPlanning;
export const setModelPlanningForTests = (on: boolean): void => { modelPlanning = on; };
