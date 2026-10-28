import {
	createFormHook,
	createFormHookContexts,
	useSelector,
} from "@tanstack/react-form";
import { type ComponentProps, type ReactNode, useId } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { NativeSelect } from "./ui/native-select";
import { Textarea } from "./ui/textarea";

const { fieldContext, formContext, useFieldContext } = createFormHookContexts();

type TextFieldProps = Omit<
	ComponentProps<typeof Input>,
	"value" | "defaultValue" | "name" | "onChange" | "onBlur"
> & {
	label: string;
	description?: ReactNode;
};

function TextField({ label, description, id, ...props }: TextFieldProps) {
	const field = useFieldContext<string>();
	const state = useSelector(field.store, (state) => state);
	const generatedId = useId();
	const inputId = id ?? generatedId;
	const invalid = state.meta.isTouched && !state.meta.isValid;
	const describedBy =
		[
			props["aria-describedby"],
			description && `${inputId}-description`,
			invalid && `${inputId}-error`,
		]
			.filter(Boolean)
			.join(" ") || undefined;
	const control = {
		...props,
		id: inputId,
		name: field.name,
		value: state.value,
		onBlur: field.handleBlur,
		"aria-invalid": invalid,
		"aria-describedby": describedBy,
	};
	return (
		<Field data-invalid={invalid}>
			<FieldLabel htmlFor={inputId}>{label}</FieldLabel>
			<Input
				{...control}
				onChange={(event) => field.handleChange(event.target.value)}
			/>
			{description && (
				<FieldDescription id={`${inputId}-description`}>
					{description}
				</FieldDescription>
			)}
			{invalid && (
				<FieldError
					id={`${inputId}-error`}
					errors={state.meta.errors.map((message) => ({
						message: String(message),
					}))}
				/>
			)}
		</Field>
	);
}

function TextareaField({
	label,
	description,
	id,
	...props
}: Omit<
	ComponentProps<typeof Textarea>,
	"value" | "defaultValue" | "name" | "onChange" | "onBlur"
> & { label: string; description?: ReactNode }) {
	const field = useFieldContext<string>();
	const state = useSelector(field.store, (state) => state);
	const generatedId = useId();
	const inputId = id ?? generatedId;
	const invalid = state.meta.isTouched && !state.meta.isValid;
	const describedBy =
		[
			props["aria-describedby"],
			description && `${inputId}-description`,
			invalid && `${inputId}-error`,
		]
			.filter(Boolean)
			.join(" ") || undefined;
	return (
		<Field data-invalid={invalid}>
			<FieldLabel htmlFor={inputId}>{label}</FieldLabel>
			<Textarea
				{...props}
				id={inputId}
				name={field.name}
				value={state.value}
				onBlur={field.handleBlur}
				onChange={(event) => field.handleChange(event.target.value)}
				aria-invalid={invalid}
				aria-describedby={describedBy}
			/>
			{description && (
				<FieldDescription id={`${inputId}-description`}>
					{description}
				</FieldDescription>
			)}
			{invalid && (
				<FieldError
					id={`${inputId}-error`}
					errors={state.meta.errors.map((message) => ({
						message: String(message),
					}))}
				/>
			)}
		</Field>
	);
}

function SelectField({
	label,
	children,
	id,
	...props
}: Omit<
	ComponentProps<typeof NativeSelect>,
	"value" | "defaultValue" | "name" | "onChange" | "onBlur"
> & { label: string }) {
	const field = useFieldContext<string>();
	const state = useSelector(field.store, (state) => state);
	const generatedId = useId();
	const inputId = id ?? generatedId;
	const invalid = state.meta.isTouched && !state.meta.isValid;
	return (
		<Field data-invalid={invalid}>
			<FieldLabel htmlFor={inputId}>{label}</FieldLabel>
			<NativeSelect
				{...props}
				id={inputId}
				name={field.name}
				value={state.value}
				onBlur={field.handleBlur}
				onChange={(event) => field.handleChange(event.target.value)}
				aria-invalid={invalid}
				aria-describedby={
					[props["aria-describedby"], invalid && `${inputId}-error`]
						.filter(Boolean)
						.join(" ") || undefined
				}
			>
				{children}
			</NativeSelect>
			{invalid && (
				<FieldError
					id={`${inputId}-error`}
					errors={state.meta.errors.map((message) => ({
						message: String(message),
					}))}
				/>
			)}
		</Field>
	);
}

export const { useAppForm } = createFormHook({
	fieldContext,
	formContext,
	fieldComponents: { TextField, TextareaField, SelectField },
	formComponents: {},
});
