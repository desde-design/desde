/**
 * The numbers and rows the demo argues about.
 *
 * Deliberately opinionated. This prototype exists to give a first-time
 * reviewer something worth commenting ON within seconds, so it carries a
 * couple of figures somebody would question (an error rate that went UP while
 * everything else improved), one visibly unhealthy row, and a control with an
 * option nobody would ship (`Nobody`).
 *
 * Split out of `App.tsx` when the demo became three pages, so Overview and
 * Workspaces can disagree about the same workspaces without two copies
 * drifting apart.
 */
export const METRICS = [
  { label: "Active workspaces", value: "1,284", delta: "+12.4%", positive: true },
  { label: "Requests today", value: "48,210", delta: "+3.1%", positive: true },
  { label: "Error rate", value: "0.42%", delta: "+0.18%", positive: false },
  { label: "Median latency", value: "184ms", delta: "-22ms", positive: true },
]

export const ROWS = [
  { name: "acme-production", region: "us-east-1", status: "Healthy", requests: "18,402", owner: "Platform" },
  { name: "acme-staging", region: "us-east-1", status: "Healthy", requests: "4,118", owner: "Platform" },
  { name: "northwind-eu", region: "eu-west-2", status: "Degraded", requests: "9,733", owner: "Growth" },
  { name: "internal-tools", region: "us-west-2", status: "Healthy", requests: "2,004", owner: "Internal" },
]
