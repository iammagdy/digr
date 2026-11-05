/**
 * STAGE F: THE SHARED SESSION OF THE END-TO-END TESTS. The routes read the signed-in viewer and the admin client through two modules the test files mock (`tests/stage4-e2e-*.test.ts`); both mocks read THIS object, so every flow can sign in as someone, sign out, or point the routes at its own fake world.
 * `viewerCalls` and `adminCalls` count how often a route asked who the viewer is and touched the database: a route that is OFF must leave both at zero.
 */
export const session: { viewer: { userId: string; isGuest: boolean; emailVerified: boolean } | null; client: unknown; viewerCalls: number; adminCalls: number } = { viewer: null, client: null, viewerCalls: 0, adminCalls: 0 };
export const signInAs = (userId: string | null): void => { session.viewer = userId ? { userId, isGuest: false, emailVerified: true } : null; session.viewerCalls = 0; session.adminCalls = 0; };
