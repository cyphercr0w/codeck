import "../styles/wizard-steps.css";

interface Step {
	label: string;
}

interface WizardStepsProps {
	steps: Step[];
	currentStep: number; // 0-based index of the active step
}

export function WizardSteps({ steps, currentStep }: WizardStepsProps) {
	return (
		<div class="wizard-steps">
			{steps.map((step, i) => {
				const completed = i < currentStep;
				const active = i === currentStep;
				let cls = "wizard-step";
				if (completed) cls += " wizard-step--completed";
				else if (active) cls += " wizard-step--active";

				return (
					<div key={step.label} class={cls}>
						<div class="wizard-step-circle">
							{completed ? (
								<svg
									class="wizard-step-check"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2.5"
									stroke-linecap="round"
									stroke-linejoin="round"
									aria-hidden="true"
								>
									<polyline points="20 6 9 17 4 12" />
								</svg>
							) : (
								i + 1
							)}
						</div>
						<span class="wizard-step-label">{step.label}</span>
					</div>
				);
			})}
		</div>
	);
}
