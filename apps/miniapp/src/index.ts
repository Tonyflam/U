/**
 * @whalepod/miniapp — onboarding logic (transport-agnostic).
 *
 * The Next.js / React shell wires the handlers below into route handlers and
 * a UI flow driven by `onboardingReducer`. UI shell lives behind the
 * testnet-wiring unit so that the wallet-connect integration target exists
 * before any JSX is shipped.
 */
export {
  initialOnboardingState,
  onboardingReducer,
  OnboardingTransitionError,
  type OnboardingEvent,
  type OnboardingState,
} from './onboarding.js';
export { OnboardCompleteRequest, OnboardStartRequest } from './onboardSchema.js';
export {
  onboardCompleteHandler,
  onboardStartHandler,
  OnboardError,
  type OnboardDeps,
  type OnboardRepo,
  type ExchangeSubmitter,
  type ProvisionalRow,
  type StartResponse,
  type VerifyTypedDataFn,
} from './onboardHandler.js';
