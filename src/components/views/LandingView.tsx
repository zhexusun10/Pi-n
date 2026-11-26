import React, { useState } from "react";
import { motion, useIsPresent, useReducedMotion } from "motion/react";
import { PromptBox, type PromptBoxSubmitOptions } from "../ui/chatgpt-prompt-input";
import { DotPattern } from "../ui/dot-pattern";
import { PiBrandMark } from "../ui/PiBrandMark";
import type { ComposerDrafts } from "../../services/composerDrafts";
import type { LandingBackground } from "../../services/displayPreferences";
import type { PlanMode } from "../../types";

interface LandingViewProps {
  goal: string;
  setGoal: (val: string) => void;
  onPlanGoal: (val: string, options?: PromptBoxSubmitOptions) => boolean | void | Promise<boolean>;
  isBusy: boolean;
  planMode?: PlanMode;
  onPlanModeChange?: (mode: PlanMode) => void;
  isWorking?: boolean;
  onInterrupt?: () => void;
  repository?: string;
  background?: LandingBackground;
  draftStore?: ComposerDrafts;
  draftKey?: string;
}

const TITLE_EXIT_DURATION = 0.2;
const TITLE_ENTER_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const TITLE_ENTER_DURATION = 0.42;

export const LandingView: React.FC<LandingViewProps> = React.memo(({
  goal,
  setGoal,
  onPlanGoal,
  isBusy,
  planMode,
  onPlanModeChange,
  isWorking,
  onInterrupt,
  repository,
  background = "paths",
  draftStore,
  draftKey,
}) => {
  const reduceMotion = useReducedMotion();
  const isPresent = useIsPresent();
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  const lineInitial = reduceMotion ? false : { opacity: 0, y: 10 };
  const lineAnimate = { opacity: 1, y: 0 };
  return (
    <div
      className="landing-screen"
      inert={!isPresent}
    >
      <div className="landing-center-content">
        <div className="landing-title-space">
          <div className="landing-title-container">
            {background === "dots" && (
              <motion.div
                className="landing-title-dot-pattern"
                aria-hidden="true"
                initial={reduceMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: reduceMotion ? 0 : TITLE_ENTER_DURATION, ease: TITLE_ENTER_EASE }}
              >
                {/* Wide spacing keeps the dots as a quiet texture rather than a grid. */}
                <DotPattern width={24} height={24} cr={1} />
              </motion.div>
            )}
            <motion.div
              className="landing-title-copy"
              initial={false}
              animate={{
                opacity: isComposerExpanded ? 0 : 1,
                y: reduceMotion || !isComposerExpanded ? 0 : -14,
                visibility: isComposerExpanded ? "hidden" : "visible",
              }}
              transition={{
                opacity: { duration: reduceMotion ? 0 : TITLE_EXIT_DURATION },
                y: { duration: reduceMotion ? 0 : TITLE_EXIT_DURATION },
                visibility: { duration: 0, delay: !reduceMotion && isComposerExpanded ? TITLE_EXIT_DURATION : 0 },
              }}
            >
              <motion.p
                className="landing-title"
                initial={lineInitial}
                animate={lineAnimate}
                transition={{ duration: reduceMotion ? 0 : TITLE_ENTER_DURATION, delay: reduceMotion ? 0 : 0.06, ease: TITLE_ENTER_EASE }}
              >
                Build Anything
              </motion.p>
              <motion.p
                className="landing-title"
                aria-label="With Pi^n."
                initial={lineInitial}
                animate={lineAnimate}
                transition={{ duration: reduceMotion ? 0 : TITLE_ENTER_DURATION, delay: reduceMotion ? 0 : 0.12, ease: TITLE_ENTER_EASE }}
              >
                With{" "}
                <PiBrandMark monochrome className="landing-brand-mark" />
                .
              </motion.p>
              <motion.p
                className="landing-subtitle"
                initial={lineInitial}
                animate={lineAnimate}
                transition={{ duration: reduceMotion ? 0 : TITLE_ENTER_DURATION, delay: reduceMotion ? 0 : 0.18, ease: TITLE_ENTER_EASE }}
              >
                <span className="landing-subtitle-key">Direct</span> with one pi.{" "}
                <span className="landing-subtitle-key">Compile</span> into many.
              </motion.p>
            </motion.div>
          </div>
        </div>
        <div className="landing-composer">
          <PromptBox
            layoutId="conversation-composer"
            expandDelay={TITLE_EXIT_DURATION}
            onExpandedChange={setIsComposerExpanded}
            repository={repository}
            draftStore={draftStore}
            draftKey={draftKey}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onSubmit={(val, options) => onPlanGoal(val, options)}
            isBusy={isBusy}
            isWorking={isWorking}
            onInterrupt={onInterrupt}
            planMode={planMode}
            onPlanModeChange={onPlanModeChange}
            placeholder=""
          />
        </div>
      </div>
    </div>
  );
});

LandingView.displayName = "LandingView";
