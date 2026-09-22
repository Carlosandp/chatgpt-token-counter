// Reference limits for the daily bar.
//
// OpenAI does not publish a daily token cap for any plan, so there is nothing official to read. The
// numbers below are this extension's own reference: a rough ceiling per plan, used only to turn the
// running daily estimate into a percentage and to decide when the bar turns amber or red. They are not
// your account's quota, and the bar says so wherever it shows them.
//
// How each one was set, so they can be argued with and adjusted:
//   free  36k   the published message allowance over a day, at roughly 600 tokens per exchange.
//   go    360k  OpenAI describes Go as about ten times the Free allowance; 36k x 10.
//   plus  1.5M  the message allowance alone lands near 800k/day, but Plus also gets longer context and
//               reasoning tokens, which push sustained heavy use to roughly 1-1.5M. Set at the top.
//   pro   5M    marketed as unlimited. 5M is a practical ceiling for continuous use of the reasoning
//               models rather than a limit anyone is expected to reach.
//
// Changing a value here changes only what the percentage is measured against; nothing else depends on it.
(() => {
  'use strict';

  const GC = (globalThis.GPTCounter = globalThis.GPTCounter || {});

  GC.PLAN_LIMITS = {
    'free': 36_000,
    'go':   360_000,
    'plus': 1_500_000,
    'pro':  5_000_000,
  };

  // Where the bar changes colour, as a share of the limit above.
  GC.PLAN_THRESHOLDS = {
    //          amber            red
    'free': { warn: 0.75,  danger: 0.917 }, // 27k      33k
    'go':   { warn: 0.417, danger: 0.694 }, // 150k     250k
    'plus': { warn: 0.50,  danger: 0.833 }, // 750k     1.25M
    'pro':  { warn: 0.50,  danger: 0.75  }, // 2.5M     3.75M
  };
})();
