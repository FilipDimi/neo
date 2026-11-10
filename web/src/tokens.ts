/** The look of the three artboards, as values. tokens.css carries the same values under the same names. */
export const color = {
  ground: '#0B0B0C',
  surface: '#151517',
  raised: '#1C1C1E',
  line: '#2A2A2E',
  headerLine: '#222226',
  text: '#F4F4F6',
  soft: '#C7C7CC',
  muted: '#9A9AA2',
  dim: '#6F6F78',
  working: '#F5B700',
  review: '#76D3CC',
  waiting: '#F2C76B',
  waitingGround: '#1A1500',
  waitingEdge: '#6B5A1F',
  onWaiting: '#1A1200',
  silent: '#E0625A',
  silentGround: '#1A0F0E',
  silentEdge: '#6B2E2A',
  done: '#7CF0BF',
  idle: '#3A3A40',
  chosenGround: '#1A1F2E',
  chosenEdge: '#4A5B8A',
} as const;

/** The colour a card's attention value stands for. */
export const attentionColor = { none: color.idle, working: color.working, review: color.review, waiting_on_you: color.waiting, over_budget: color.waiting, silent: color.silent } as const;
