import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Sparkles } from "lucide-react";

function UpgradeToProAIButtonTooltip() {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger>
          <Sparkles className="h-4 w-4 text-gray-400 pointer-events-none" />
        </TooltipTrigger>
        <TooltipContent>
          <p>Upgrade to Pro to use AI features.</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default UpgradeToProAIButtonTooltip;