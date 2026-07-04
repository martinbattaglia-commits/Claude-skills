import type { LearnContent } from "@/lib/static/types";

// Editorial reading list shown on MarketsScreen. Placeholder content until
// a real CMS or markdown library lands.
export const LEARN_CONTENT: LearnContent = {
  startHere: [
    {
      id: "l1",
      title: "What is index investing?",
      blurb:
        "The simplest, evidence-based way to build wealth. Why owning the whole market beats picking winners.",
      readTime: 5,
      tag: "BASICS",
    },
    {
      id: "l2",
      title: "Asset allocation 101",
      blurb: "Stocks, bonds, alternatives, cash — how to think about the mix that fits your goals.",
      readTime: 7,
      tag: "BASICS",
    },
    {
      id: "l3",
      title: "Why fees matter more than you think",
      blurb:
        "A 1% fee = 25% less wealth in 30 years. The most controllable factor in your returns.",
      readTime: 6,
      tag: "FEES",
    },
    {
      id: "l4",
      title: "How to rebalance — and how often",
      blurb: "Calendar vs threshold rebalancing. The case for boring discipline.",
      readTime: 8,
      tag: "REBALANCE",
    },
  ],
  topics: [
    { id: "t1", label: "Allocation", count: 12 },
    { id: "t2", label: "Rebalancing", count: 8 },
    { id: "t3", label: "Fees & taxes", count: 6 },
    { id: "t4", label: "Behavior", count: 9 },
    { id: "t5", label: "Thai market", count: 5 },
    { id: "t6", label: "Global indices", count: 7 },
  ],
  recommendedForYou: [
    {
      id: "rl1",
      title: "Should you tilt toward US equity?",
      blurb: "Your portfolio is currently 46% US. Here's the case for and against.",
      readTime: 9,
      tag: "FOR YOU",
    },
    {
      id: "rl2",
      title: "Understanding fund overlap",
      blurb: "Three of your funds all hold the same top 10 companies. Why this matters.",
      readTime: 7,
      tag: "FOR YOU",
    },
    {
      id: "rl3",
      title: "When NOT to rebalance",
      blurb: "Sometimes drift is your friend. Tax drag, fee drag, and patience.",
      readTime: 6,
      tag: "FOR YOU",
    },
  ],
};
