import { expect, test } from "bun:test";
import {
	metricDescription,
	metricLabel,
} from "../../src/analytics/metric-names";
import { formatMetricValue as formatMeasurement } from "../../src/analytics/metric-units";

test("shared UCUM formatting handles GPU temperature, clocks, power and rates in both locales", () => {
	expect(formatMeasurement("70", "Cel", "en").text).toBe("70 °C");
	expect(formatMeasurement("70", "Cel", "en").exact).toBe("70 Cel");
	expect(formatMeasurement("1500000000", "Hz", "en").text).toBe("1.5 GHz");
	expect(formatMeasurement("1500000000", "Hz", "fr").text).toContain("1,5");
	expect(formatMeasurement("1048576", "By/s", "en").text).toBe("1 MiB/s");
	expect(formatMeasurement(70.5, "W", "fr").text).toContain("70,5 W");
	expect(formatMeasurement("9007199254740993", "Hz", "en").exact).toBe(
		"9,007,199,254,740,993 Hz",
	);
	expect(metricLabel("recount.process.gpu.memory.used")).not.toBe(
		"recount.process.gpu.memory.used",
	);
	expect(metricDescription("recount.gpu.pipe.activity")).not.toBeNull();
});

test("Activity formats ratio units as percentages without changing stored values or diagnostics", () => {
	for (const unit of ["1", "1{gpu}", "s/s"]) {
		const formatted = formatMeasurement(0.8648393808352174, unit, "en");
		expect(formatted.text).toBe("86.5%");
		expect(formatMeasurement(0.8648393808352174, unit, "fr").text).toBe(
			"86,5 %",
		);
		expect(formatMeasurement(0, unit, "en").text).toBe("0%");
	}
	expect(formatMeasurement(0.8648393808352174, "1", "en").exact).toBe(
		"0.8648393808352174",
	);
	expect(formatMeasurement(1, "{status}", "en").text).toBe("1");
	expect(formatMeasurement(86.48393808352174, "%", "en").text).toBe("86.5%");
});
