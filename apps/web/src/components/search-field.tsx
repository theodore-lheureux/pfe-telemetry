import { SearchIcon } from "lucide-react";
import { useId } from "react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Label } from "./ui/label";

/** A list's search box: its placeholder doubles as the visually hidden label. */
export function SearchField({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	const id = useId();
	return (
		<div className="w-full max-w-sm">
			<Label htmlFor={id} className="sr-only">
				{label}
			</Label>
			<InputGroup>
				<InputGroupAddon>
					<SearchIcon aria-hidden="true" />
				</InputGroupAddon>
				<InputGroupInput
					id={id}
					type="search"
					value={value}
					placeholder={label}
					onChange={(event) => onChange(event.target.value)}
				/>
			</InputGroup>
		</div>
	);
}
