"use client"

import { useState } from "react"

interface FAQItem {
  question: string
  answer: string
}

const faqData: FAQItem[] = [
  {
    question: "What is Nyx and who is it for?",
    answer:
      "Nyx is a confidential short-term prefunding credit facility for Stellar anchors and payment institutions. It allows approved anchors to borrow 1-5 day USDC against private tokenized RWA reserves without exposing their balance sheets.",
  },
  {
    question: "Why is anchor identity separate from credit positions?",
    answer:
      "Because institutional compliance and credit limits depend on anchor risk profiles. The ParticipantPolicy registry binds each anchor wallet to a verified KYB state, risk tier, and credit limit before draws are authorized.",
  },
  {
    question: "What does the zero-knowledge proof verify?",
    answer:
      "The proof verifies that the anchor's private RWA collateral covers the requested USDC draw after haircuts, and that the position does not exceed their risk-tier limits—all without revealing private balances.",
  },
  {
    question: "What assets are supported as collateral?",
    answer:
      "Nyx supports tokenized treasuries (like cTBill) and tokenized gold (like cXAUm) as private collateral, with payouts and settlements denominated in confidential USDC (cUSDC).",
  },
  {
    question: "How does repayment and lock release work?",
    answer:
      "Repayment of USDC automatically releases the collateral lock in the CollateralLockRegistry. If repayment is not made before the maximum tenor (1-5 days), the locked collateral commitment can be liquidated.",
  },
  {
    question: "Why build this on Stellar?",
    answer:
      "Stellar provides native USDC liquidity rails, high-speed settlement, and native support for tokenized RWA assets alongside compliance hooks for confidential tokens.",
  },
]

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="m6 9 6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function FAQSection() {
  const [openItems, setOpenItems] = useState<number[]>([])

  const toggleItem = (index: number) => {
    setOpenItems((prev) => (prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]))
  }

  return (
    <div className="w-full flex justify-center items-start">
      <div className="flex-1 px-4 md:px-12 py-16 md:py-20 flex flex-col lg:flex-row justify-start items-start gap-6 lg:gap-12">
        {/* Left Column - Header */}
        <div className="w-full lg:flex-1 flex flex-col justify-center items-start gap-4 lg:py-5">
          <div className="w-full flex flex-col justify-center text-[#49423D] font-semibold leading-tight md:leading-[44px] font-sans text-4xl tracking-tight">
            Frequently Asked Questions
          </div>
          <div className="w-full text-[#605A57] text-base font-normal leading-7 font-sans">
            Understand how private RWA collateral, ZK proofs,
            <br className="hidden md:block" />
            and prefunding credit facilities fit together.
          </div>
        </div>

        {/* Right Column - FAQ Items */}
        <div className="w-full lg:flex-1 flex flex-col justify-center items-center">
          <div className="w-full flex flex-col">
            {faqData.map((item, index) => {
              const isOpen = openItems.includes(index)

              return (
                <div key={index} className={`w-full border-b border-[rgba(73,66,61,0.16)] overflow-hidden transition-colors duration-300 ${isOpen ? "bg-[rgba(73,66,61,0.02)]" : ""}`}>
                  <button
                    onClick={() => toggleItem(index)}
                    className="group w-full px-5 py-[18px] flex justify-between items-center gap-5 text-left hover:bg-[rgba(73,66,61,0.015)] transition-colors duration-200"
                    aria-expanded={isOpen}
                  >
                    <div className="flex-1 text-[#49423D] group-hover:text-black text-base font-medium leading-6 font-sans transition-colors">
                      {item.question}
                    </div>
                    <div className="flex justify-center items-center">
                      <ChevronDownIcon
                        className={`w-6 h-6 text-[rgba(73,66,61,0.60)] group-hover:text-black transition-transform duration-300 ease-in-out ${
                          isOpen ? "rotate-180" : "rotate-0"
                        }`}
                      />
                    </div>
                  </button>

                  <div
                    className={`overflow-hidden transition-all duration-300 ease-in-out ${
                      isOpen ? "max-h-96 opacity-100" : "max-h-0 opacity-0"
                    }`}
                  >
                    <div className="px-5 pb-[18px] text-[#605A57] text-sm font-normal leading-6 font-sans">
                      {item.answer}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
