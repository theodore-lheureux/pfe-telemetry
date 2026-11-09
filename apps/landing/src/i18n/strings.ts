import type { Lang } from "./index";

// All landing-site copy. French follows Québec usage (courriel, etc.).
const en = {
	meta: {
		homeTitle: "Recount · Telemetry for distributed work",
		homeDescription:
			"Recount gathers telemetry from your machines and keeps it in one place. Mark the moments that matter and see what was happening.",
	},
	nav: {
		home: "Recount, home",
		docs: "Docs",
		pricing: "Pricing",
		changelog: "Changelog",
		signIn: "Sign in",
		getStarted: "Get started",
		openApp: "Open Recount",
		menu: "Menu",
		github: "GitHub",
		skip: "Skip to content",
	},
	hero: {
		eyebrow: "Telemetry for distributed work",
		title: "See what your machines were doing, when it mattered",
		text: "Recount gathers telemetry from your machines and keeps it in one place. Mark the moments that matter, like a release, a test or a slowdown, and see what was happening.",
		getStarted: "Get started",
		howItWorks: "How it works",
	},
	how: {
		title: "How it works",
		intro:
			"Connect your machines once, then come back to any moment you need to understand.",
		step: "Step",
		steps: [
			{
				name: "Connect your machines",
				text: "Install the collector and link it to your project. It runs quietly in the background.",
			},
			{
				name: "Mark a moment",
				text: "Save the time and the machines you care about, so the data is easy to find later.",
			},
			{
				name: "See what happened",
				text: "Open it to see what your machines were doing, and share it with your team.",
			},
		],
	},
	features: {
		title: "Features",
		intro:
			"Built to give you a clear, accurate record of how your machines are used.",
		items: [
			{
				title: "Reliable",
				text: "A dropped connection doesn't mean lost data. It catches up once you're back online.",
			},
			{
				title: "Open standards",
				text: "Works with the tools you already use instead of locking you in.",
			},
			{
				title: "Secure",
				text: "Only the machines and people you allow can send or see your data.",
			},
			{
				title: "Accurate",
				text: "You see what was measured. Nothing is filled in or smoothed over.",
			},
			{
				title: "Made for teams",
				text: "Projects keep work organized, and everyone sees the same picture.",
			},
			{
				title: "Simple to set up",
				text: "No changes to your code or workflows. Install the collector and it does the rest.",
			},
		],
	},
	deployment: {
		title: "Cloud or self-hosted",
		intro:
			"Use Recount Cloud, or run it yourself. It's the same product either way.",
		cloud: {
			title: "Recount Cloud",
			text: "We run it for you. Sign in, create a project and connect your first machine.",
			points: [
				"No servers to set up or maintain",
				"Updates and backups handled for you",
				"Hosted in Canada",
			],
			cta: "Sign in",
		},
		self: {
			title: "Self-hosted",
			text: "Run Recount on your own servers, so your telemetry never leaves your network.",
			points: [
				"Your data stays on your infrastructure",
				"Runs with standard containers",
				"The same product as the cloud",
			],
			cta: "Self-hosting guide",
		},
	},
	faq: {
		title: "Questions and answers",
		intro: "Can't find what you're looking for?",
		contact: "Contact us",
		items: [
			{
				q: "What does Recount collect?",
				a: "Telemetry about how your machines are used, such as how busy they are over time. It doesn't read the contents of your files.",
			},
			{
				q: "Will it slow my machines down?",
				a: "The collector is small and built to run in the background without getting in the way of your work.",
			},
			{
				q: "What happens if a machine goes offline?",
				a: "The collector keeps measuring and holds on to the data. It sends everything once the connection is back.",
			},
			{
				q: "Which machines are supported?",
				a: "Linux machines today. Support for more systems is on the way.",
			},
			{
				q: "Where is my data stored?",
				a: "Recount Cloud stores your data in Canada. If you self-host, it stays on your own servers.",
			},
			{
				q: "How much does it cost?",
				a: 'Recount is free while it\'s in early access. See <a href="/pricing/">pricing</a> for details.',
			},
		],
	},
	getStarted: {
		title: "Get started",
		text: "Sign in, create a project and connect your first machine.",
		signIn: "Sign in to Recount",
		quickStart: "Read the quick start",
	},
	footer: {
		tagline: "Telemetry from your machines, kept in one place.",
		product: "Product",
		docs: "Docs",
		company: "Company",
		features: "Features",
		introduction: "Introduction",
		quickStart: "Quick start",
		concepts: "Concepts",
		collector: "Collector",
		selfHosting: "Self-hosting",
		contact: "Contact",
		privacy: "Privacy",
		terms: "Terms",
		language: "Language",
		theme: "Theme",
		system: "System",
		light: "Light",
		dark: "Dark",
	},
	pricing: {
		title: "Pricing",
		description:
			"Recount is free while it's in early access, in the cloud or on your own servers.",
		intro:
			"Free while Recount is in early access, in the cloud or on your own servers. Talk to us for larger rollouts.",
		plans: {
			cloud: {
				title: "Cloud",
				badge: "Early access",
				price: "Free",
				note: "during early access",
				text: "We run Recount for you. Sign in and connect your first machine in minutes.",
				points: [
					"Everything Recount does",
					"Hosted in Canada",
					"Updates and backups handled for you",
				],
				cta: "Get started",
			},
			self: {
				title: "Self-hosted",
				price: "Free",
				note: "on your own servers",
				text: "Run Recount on your own infrastructure, so your telemetry never leaves your network.",
				points: [
					"Everything Recount does",
					"Your data stays on your network",
					"You choose when to update",
				],
				cta: "Self-hosting guide",
			},
			enterprise: {
				title: "Enterprise",
				price: "Custom",
				note: "cloud or self-hosted",
				text: "For organizations rolling Recount out across many teams or sites.",
				points: [
					"Help planning your rollout",
					"Priority support",
					"Custom terms and invoicing",
				],
				cta: "Contact us",
			},
		},
		compare: {
			title: "Compare plans",
			feature: "Feature",
			included: "Included",
			notIncluded: "Not included",
			groups: [
				{
					name: "Collection",
					rows: [
						{ name: "Collector for Linux", cells: [true, true, true] },
						{
							name: "Keeps data through network drops",
							cells: [true, true, true],
						},
						{
							name: "Open standards (OpenTelemetry)",
							cells: [true, true, true],
						},
					],
				},
				{
					name: "Moments",
					rows: [
						{ name: "Saved moments", cells: [true, true, true] },
						{ name: "Charts for each machine", cells: [true, true, true] },
					],
				},
				{
					name: "Teams",
					rows: [
						{ name: "Organizations and projects", cells: [true, true, true] },
						{ name: "Roles and invitations", cells: [true, true, true] },
						{ name: "English and French", cells: [true, true, true] },
					],
				},
				{
					name: "Security",
					rows: [
						{
							name: "Passwordless sign-in and passkeys",
							cells: [true, true, true],
						},
						{
							name: "A credential for each machine",
							cells: [true, true, true],
						},
					],
				},
				{
					name: "Hosting",
					rows: [
						{
							name: "Where your data is stored",
							cells: ["Canada", "Your servers", "Your choice"],
						},
						{
							name: "Updates and backups",
							cells: ["Handled for you", "You manage", "Handled or assisted"],
						},
					],
				},
				{
					name: "Support",
					rows: [
						{ name: "Documentation", cells: [true, true, true] },
						{ name: "Email support", cells: [true, true, true] },
						{ name: "Priority support", cells: [false, false, true] },
						{ name: "Rollout planning", cells: [false, false, true] },
					],
				},
			],
		},
		faq: {
			title: "Pricing questions",
			items: [
				{
					q: "Is Recount really free?",
					a: "Yes. Recount Cloud is free while it's in early access, and self-hosting is free. There's no credit card to enter.",
				},
				{
					q: "What happens when early access ends?",
					a: "We'll give plenty of notice before any paid plans start. Your projects and data stay where they are.",
				},
				{
					q: "What does self-hosting cost?",
					a: "Recount itself is free to self-host. You only pay for the servers you run it on.",
				},
				{
					q: "What does Enterprise include?",
					a: "Everything Recount does, in the cloud or on your servers, plus help planning your rollout, priority support and terms that fit your organization.",
				},
				{
					q: "Where is my data stored?",
					a: "Recount Cloud stores your data in Canada. If you self-host, it stays on your own servers.",
				},
			],
		},
		cta: {
			title: "Have a question about pricing?",
			text: "We're happy to help you choose, or to talk through a larger rollout.",
			button: "Contact us",
		},
	},
	contact: {
		title: "Contact",
		description: "Get in touch with the Recount team.",
		intro:
			"We read every message and usually reply within a few business days.",
		items: [
			{
				label: "General questions",
				text: "Questions about Recount, early access or self-hosting.",
				email: "hello@recount.cloud",
			},
			{
				label: "Privacy",
				text: "Requests about your personal information.",
				email: "privacy@recount.cloud",
			},
			{
				label: "Security",
				text: "Report a vulnerability. Please don't share details publicly until we've replied.",
				email: "security@recount.cloud",
			},
		],
	},
	comingSoon: {
		title: "Coming soon",
		description:
			"Recount is in private early access and opening to more teams soon.",
		eyebrow: "Early access",
		heading: "Recount is coming soon",
		text: "We're getting Recount ready for more teams. Leave your email and we'll let you know as soon as you can sign in.",
		docs: "Read the docs",
		contact: "Contact us",
		changelog: "See what's new",
		form: {
			label: "Get an email when Recount opens",
			placeholder: "you@company.com",
			submit: "Notify me",
			sending: "Sending…",
			success: "Thanks! We'll email you when Recount opens.",
			invalid: "Enter a valid email address.",
			failed: "Something went wrong. Try again, or email hello@recount.cloud.",
			note: "We'll only use your email to tell you about early access.",
			privacy: "Privacy policy",
			or: "Meanwhile:",
		},
	},
	changelog: {
		title: "Changelog",
		intro: "New features and improvements in Recount.",
	},
	legal: {
		updated: "Last updated",
	},
};

type Strings = typeof en;

const fr: Strings = {
	meta: {
		homeTitle: "Recount · Télémétrie pour le travail distribué",
		homeDescription:
			"Recount recueille la télémétrie de vos machines et la garde au même endroit. Marquez les moments importants et voyez ce qui se passait.",
	},
	nav: {
		home: "Recount, accueil",
		docs: "Documentation",
		pricing: "Tarifs",
		changelog: "Nouveautés",
		signIn: "Se connecter",
		getStarted: "Commencer",
		openApp: "Ouvrir Recount",
		menu: "Menu",
		github: "GitHub",
		skip: "Aller au contenu",
	},
	hero: {
		eyebrow: "Télémétrie pour le travail distribué",
		title: "Voyez ce que faisaient vos machines au moment qui compte",
		text: "Recount recueille la télémétrie de vos machines et la garde au même endroit. Marquez les moments importants, comme une mise en production, un test ou un ralentissement, et voyez ce qui se passait.",
		getStarted: "Commencer",
		howItWorks: "Fonctionnement",
	},
	how: {
		title: "Fonctionnement",
		intro:
			"Connectez vos machines une seule fois, puis revenez à n’importe quel moment que vous voulez comprendre.",
		step: "Étape",
		steps: [
			{
				name: "Connectez vos machines",
				text: "Installez le collecteur et liez-le à votre projet. Il fonctionne discrètement en arrière-plan.",
			},
			{
				name: "Marquez un moment",
				text: "Enregistrez la période et les machines qui vous intéressent pour retrouver facilement les données plus tard.",
			},
			{
				name: "Voyez ce qui s’est passé",
				text: "Ouvrez-le pour voir ce que faisaient vos machines et partagez-le avec votre équipe.",
			},
		],
	},
	features: {
		title: "Fonctionnalités",
		intro:
			"Conçu pour vous donner un portrait clair et exact de l’utilisation de vos machines.",
		items: [
			{
				title: "Fiable",
				text: "Une connexion perdue ne veut pas dire des données perdues. Tout est rattrapé au retour en ligne.",
			},
			{
				title: "Normes ouvertes",
				text: "Fonctionne avec les outils que vous utilisez déjà, sans vous enfermer.",
			},
			{
				title: "Sécurisé",
				text: "Seules les machines et les personnes que vous autorisez peuvent envoyer ou voir vos données.",
			},
			{
				title: "Exact",
				text: "Vous voyez ce qui a été mesuré. Rien n’est inventé ni lissé.",
			},
			{
				title: "Pensé pour les équipes",
				text: "Les projets gardent le travail organisé, et tout le monde voit la même chose.",
			},
			{
				title: "Simple à installer",
				text: "Aucun changement à votre code ni à vos façons de faire. Installez le collecteur, il s’occupe du reste.",
			},
		],
	},
	deployment: {
		title: "Infonuagique ou auto-hébergé",
		intro:
			"Utilisez Recount Cloud ou hébergez-le vous-même. C’est le même produit dans les deux cas.",
		cloud: {
			title: "Recount Cloud",
			text: "Nous l’exploitons pour vous. Connectez-vous, créez un projet et branchez votre première machine.",
			points: [
				"Aucun serveur à installer ni à entretenir",
				"Mises à jour et sauvegardes prises en charge",
				"Hébergé au Canada",
			],
			cta: "Se connecter",
		},
		self: {
			title: "Auto-hébergé",
			text: "Exécutez Recount sur vos propres serveurs : votre télémétrie ne quitte jamais votre réseau.",
			points: [
				"Vos données restent sur votre infrastructure",
				"Fonctionne avec des conteneurs standards",
				"Le même produit qu’en infonuagique",
			],
			cta: "Guide d’auto-hébergement",
		},
	},
	faq: {
		title: "Questions et réponses",
		intro: "Vous ne trouvez pas ce que vous cherchez?",
		contact: "Écrivez-nous",
		items: [
			{
				q: "Que recueille Recount?",
				a: "De la télémétrie sur l’utilisation de vos machines, comme leur niveau d’activité dans le temps. Recount ne lit pas le contenu de vos fichiers.",
			},
			{
				q: "Est-ce que ça ralentit mes machines?",
				a: "Le collecteur est léger et conçu pour fonctionner en arrière-plan sans nuire à votre travail.",
			},
			{
				q: "Que se passe-t-il si une machine se déconnecte?",
				a: "Le collecteur continue de mesurer et conserve les données. Il envoie tout dès que la connexion revient.",
			},
			{
				q: "Quelles machines sont prises en charge?",
				a: "Les machines Linux pour l’instant. La prise en charge d’autres systèmes s’en vient.",
			},
			{
				q: "Où mes données sont-elles stockées?",
				a: "Recount Cloud stocke vos données au Canada. Si vous l’hébergez vous-même, elles restent sur vos serveurs.",
			},
			{
				q: "Combien ça coûte?",
				a: 'Recount est gratuit pendant l’accès anticipé. Consultez les <a href="/fr/pricing/">tarifs</a> pour en savoir plus.',
			},
		],
	},
	getStarted: {
		title: "Commencer",
		text: "Connectez-vous, créez un projet et branchez votre première machine.",
		signIn: "Se connecter à Recount",
		quickStart: "Lire le démarrage rapide",
	},
	footer: {
		tagline: "La télémétrie de vos machines, au même endroit.",
		product: "Produit",
		docs: "Documentation",
		company: "Entreprise",
		features: "Fonctionnalités",
		introduction: "Introduction",
		quickStart: "Démarrage rapide",
		concepts: "Concepts",
		collector: "Collecteur",
		selfHosting: "Auto-hébergement",
		contact: "Contact",
		privacy: "Confidentialité",
		terms: "Conditions",
		language: "Langue",
		theme: "Thème",
		system: "Système",
		light: "Clair",
		dark: "Sombre",
	},
	pricing: {
		title: "Tarifs",
		description:
			"Recount est gratuit pendant l’accès anticipé, en infonuagique ou sur vos propres serveurs.",
		intro:
			"Gratuit pendant l’accès anticipé, en infonuagique ou sur vos propres serveurs. Écrivez-nous pour les déploiements plus larges.",
		plans: {
			cloud: {
				title: "Infonuagique",
				badge: "Accès anticipé",
				price: "Gratuit",
				note: "pendant l’accès anticipé",
				text: "Nous exploitons Recount pour vous. Connectez-vous et branchez votre première machine en quelques minutes.",
				points: [
					"Tout ce que fait Recount",
					"Hébergé au Canada",
					"Mises à jour et sauvegardes prises en charge",
				],
				cta: "Commencer",
			},
			self: {
				title: "Auto-hébergé",
				price: "Gratuit",
				note: "sur vos propres serveurs",
				text: "Exécutez Recount sur votre propre infrastructure : votre télémétrie ne quitte jamais votre réseau.",
				points: [
					"Tout ce que fait Recount",
					"Vos données restent sur votre réseau",
					"Vous choisissez quand mettre à jour",
				],
				cta: "Guide d’auto-hébergement",
			},
			enterprise: {
				title: "Entreprise",
				price: "Sur mesure",
				note: "infonuagique ou auto-hébergé",
				text: "Pour les organisations qui déploient Recount dans plusieurs équipes ou sites.",
				points: [
					"Aide à planifier votre déploiement",
					"Soutien prioritaire",
					"Conditions et facturation sur mesure",
				],
				cta: "Écrivez-nous",
			},
		},
		compare: {
			title: "Comparer les forfaits",
			feature: "Fonctionnalité",
			included: "Inclus",
			notIncluded: "Non inclus",
			groups: [
				{
					name: "Collecte",
					rows: [
						{ name: "Collecteur pour Linux", cells: [true, true, true] },
						{
							name: "Garde les données lors des pertes de réseau",
							cells: [true, true, true],
						},
						{
							name: "Normes ouvertes (OpenTelemetry)",
							cells: [true, true, true],
						},
					],
				},
				{
					name: "Moments",
					rows: [
						{ name: "Moments enregistrés", cells: [true, true, true] },
						{
							name: "Graphiques pour chaque machine",
							cells: [true, true, true],
						},
					],
				},
				{
					name: "Équipes",
					rows: [
						{ name: "Organisations et projets", cells: [true, true, true] },
						{ name: "Rôles et invitations", cells: [true, true, true] },
						{ name: "Français et anglais", cells: [true, true, true] },
					],
				},
				{
					name: "Sécurité",
					rows: [
						{
							name: "Connexion sans mot de passe et clés d’accès",
							cells: [true, true, true],
						},
						{
							name: "Un identifiant d’accès par machine",
							cells: [true, true, true],
						},
					],
				},
				{
					name: "Hébergement",
					rows: [
						{
							name: "Où vos données sont stockées",
							cells: ["Canada", "Vos serveurs", "À votre choix"],
						},
						{
							name: "Mises à jour et sauvegardes",
							cells: [
								"Prises en charge",
								"Gérées par vous",
								"Prises en charge ou accompagnées",
							],
						},
					],
				},
				{
					name: "Soutien",
					rows: [
						{ name: "Documentation", cells: [true, true, true] },
						{ name: "Soutien par courriel", cells: [true, true, true] },
						{ name: "Soutien prioritaire", cells: [false, false, true] },
						{
							name: "Planification du déploiement",
							cells: [false, false, true],
						},
					],
				},
			],
		},
		faq: {
			title: "Questions sur les tarifs",
			items: [
				{
					q: "Recount est-il vraiment gratuit?",
					a: "Oui. Recount Cloud est gratuit pendant l’accès anticipé, et l’auto-hébergement est gratuit. Aucune carte de crédit n’est demandée.",
				},
				{
					q: "Que se passera-t-il à la fin de l’accès anticipé?",
					a: "Nous vous préviendrons bien à l’avance avant l’arrivée de forfaits payants. Vos projets et vos données restent en place.",
				},
				{
					q: "Combien coûte l’auto-hébergement?",
					a: "Recount est gratuit à héberger vous-même. Vous payez seulement les serveurs sur lesquels il fonctionne.",
				},
				{
					q: "Que comprend le forfait Entreprise?",
					a: "Tout ce que fait Recount, en infonuagique ou sur vos serveurs, avec de l’aide pour planifier votre déploiement, un soutien prioritaire et des conditions adaptées à votre organisation.",
				},
				{
					q: "Où mes données sont-elles stockées?",
					a: "Recount Cloud stocke vos données au Canada. Si vous l’hébergez vous-même, elles restent sur vos serveurs.",
				},
			],
		},
		cta: {
			title: "Une question sur les tarifs?",
			text: "Nous pouvons vous aider à choisir ou discuter d’un déploiement plus large.",
			button: "Écrivez-nous",
		},
	},
	contact: {
		title: "Contact",
		description: "Joignez l’équipe de Recount.",
		intro:
			"Nous lisons tous les messages et répondons habituellement en quelques jours ouvrables.",
		items: [
			{
				label: "Questions générales",
				text: "Questions sur Recount, l’accès anticipé ou l’auto-hébergement.",
				email: "hello@recount.cloud",
			},
			{
				label: "Confidentialité",
				text: "Demandes concernant vos renseignements personnels.",
				email: "privacy@recount.cloud",
			},
			{
				label: "Sécurité",
				text: "Signalez une vulnérabilité. Merci de ne pas en divulguer les détails avant notre réponse.",
				email: "security@recount.cloud",
			},
		],
	},
	comingSoon: {
		title: "Bientôt disponible",
		description:
			"Recount est en accès anticipé privé et s’ouvrira bientôt à plus d’équipes.",
		eyebrow: "Accès anticipé",
		heading: "Recount arrive bientôt",
		text: "Nous préparons Recount pour plus d’équipes. Laissez votre courriel et nous vous préviendrons dès que vous pourrez vous connecter.",
		docs: "Lire la documentation",
		contact: "Écrivez-nous",
		changelog: "Voir les nouveautés",
		form: {
			label: "Recevez un courriel à l’ouverture de Recount",
			placeholder: "vous@entreprise.com",
			submit: "M’avertir",
			sending: "Envoi…",
			success: "Merci! Nous vous écrirons à l’ouverture de Recount.",
			invalid: "Entrez une adresse courriel valide.",
			failed:
				"Une erreur est survenue. Réessayez ou écrivez à hello@recount.cloud.",
			note: "Nous utiliserons votre courriel seulement pour vous parler de l’accès anticipé.",
			privacy: "Politique de confidentialité",
			or: "D’ici là :",
		},
	},
	changelog: {
		title: "Nouveautés",
		intro: "Les nouvelles fonctionnalités et améliorations de Recount.",
	},
	legal: {
		updated: "Dernière mise à jour :",
	},
};

export const strings: Record<Lang, Strings> = { en, fr };
