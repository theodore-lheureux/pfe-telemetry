import { m } from "@recount/i18n/messages";

function formControl(target: EventTarget) {
	return target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
		? target
		: null;
}

export function localizeValidation(target: EventTarget) {
	const control = formControl(target);
	if (!control) return;
	control.setCustomValidity("");
	if (control.validity.valid) return;
	control.setCustomValidity(
		control.validity.valueMissing
			? m.error_required()
			: control.validity.typeMismatch &&
					control instanceof HTMLInputElement &&
					control.type === "email"
				? m.error_email()
				: m.error_invalid_input(),
	);
}

export function clearValidation(target: EventTarget) {
	formControl(target)?.setCustomValidity("");
}
