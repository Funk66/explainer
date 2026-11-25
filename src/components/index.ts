// Every component exported here is available in explainer MDX files without an import.
// When adding a component: export it here, document it in agent/prompts/authoring-guide.md, and use it in explainers/showcase.
import Callout from './Callout.astro';
import Chart from './Chart.astro';
import Column from './Column.astro';
import Columns from './Columns.astro';
import Definition from './Definition.astro';
import Flashcards from './Flashcards.astro';
import FunctionPlot from './FunctionPlot.astro';
import Mermaid from './Mermaid.astro';
import Quiz from './Quiz.astro';
import Reveal from './Reveal.astro';
import Stats from './Stats.astro';
import Step from './Step.astro';
import Steps from './Steps.astro';
import Tab from './Tab.astro';
import Tabs from './Tabs.astro';
import Term from './Term.astro';
import Timeline from './Timeline.astro';
import Walkthrough from './Walkthrough.astro';

export const components = {
  Callout, Chart, Column, Columns, Definition, Flashcards, FunctionPlot, Mermaid, Quiz,
  Reveal, Stats, Step, Steps, Tab, Tabs, Term, Timeline, Walkthrough,
};
