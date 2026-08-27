declare module "asciichart" {
	export interface PlotConfig {
		min?: number;
		max?: number;
		offset?: number;
		padding?: string;
		height?: number;
		colors?: Array<string | undefined>;
		format?: (value: number, index: number) => string;
	}

	interface AsciiChart {
		plot(series: number[] | number[][], config?: PlotConfig): string;
	}

	const asciichart: AsciiChart;
	export default asciichart;
}
