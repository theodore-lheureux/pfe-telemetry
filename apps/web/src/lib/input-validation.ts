import { m } from "@recount/i18n/messages";

function formControl(target: EventTarget) {
	return target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement
		? target
		: null;
}

function validityMessage(control: { validity: ValidityState }) {
	if (control.validity.valueMissing) return m.error_required();
	if (
		control.validity.typeMismatch &&
		control instanceof HTMLInputElement &&
		control.type === "email"
	)
		return m.error_email();
	return m.error_invalid_input();
}

export function localizeValidation(target: EventTarget) {
	const control = formControl(target);
	if (!control) return;
	control.setCustomValidity("");
	if (control.validity.valid) return;
	control.setCustomValidity(validityMessage(control));
}

export function clearValidation(target: EventTarget) {
	formControl(target)?.setCustomValidity("");
}
