---
title: Collecteur
description: Configurer le collecteur Linux.
---

`recount-collector` échantillonne les ressources du nœud et des processus Linux à partir de `/proc` et les envoie à Recount. Il fonctionne uniquement sous Linux.

## Configuration

Les paramètres sont lus une seule fois au démarrage. Les options de ligne de commande ont priorité sur les variables d’environnement; exécutez `recount-collector --help` pour connaître leurs noms.

| Variable                                  | Par défaut                     | Signification                                                                           |
| ----------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`             | `http://127.0.0.1:14317`       | Adresse d’ingestion de Recount.                                                         |
| `RECOUNT_COLLECTOR_ENROLLMENT_URL`        | Aucune                         | Adresse de l’application Web de Recount qui inscrit la machine.                         |
| `RECOUNT_COLLECTOR_ENROLLMENT_KEY_FILE`   | Aucune                         | Fichier privé qui contient la clé d’inscription. Utile seulement à l’inscription.       |
| `RECOUNT_COLLECTOR_STATE_DIRECTORY`       | `.state/collector`             | Dossier privé où la machine conserve son identité après l’inscription.                  |
| `RECOUNT_COLLECTOR_INTERVAL_MS`           | `1000`                         | Période d’échantillonnage, de 100 à 60000 ms.                                           |
| `RECOUNT_COLLECTOR_HOST_ID`               | `/etc/machine-id`              | Identité de la machine à l’inscription. Les machines clonées ont besoin d’ID distincts. |
| `RECOUNT_COLLECTOR_VISIBILITY`            | `restricted`                   | Mettez `host` seulement si le collecteur voit les processus de l’hôte.                  |
| `RECOUNT_COLLECTOR_PROCESS_NAMESPACE_ID`  | `host` avec la visibilité hôte | Identité de l’espace de noms des PID. Obligatoire en visibilité restreinte.             |
| `RECOUNT_COLLECTOR_QUEUE_DIRECTORY`       | `.state/collector-queue`       | Dossier local des données en attente d’envoi. Un collecteur par dossier.                |
| `RECOUNT_COLLECTOR_QUEUE_MAX_BYTES`       | `67108864`                     | Quantité maximale de données en file, de 1 Mio à 1 Gio.                                 |
| `RECOUNT_COLLECTOR_QUEUE_MAX_BATCHES`     | `1024`                         | Nombre maximal de lots en attente.                                                      |
| `RECOUNT_COLLECTOR_QUEUE_MAX_AGE_SECONDS` | `3600`                         | Durée d’attente maximale d’un lot avant qu’il soit abandonné.                           |
| `RUST_LOG`                                | `info`                         | Niveau de journalisation.                                                               |

Tout changement de paramètre exige un redémarrage.

## Ce qu’il recueille

- **Nœud :** temps processeur, mémoire totale et disponible, E/S disque.
- **Processus :** temps processeur, mémoire résidente, E/S disque.

Les valeurs de processeur et de disque sont des totaux cumulés, pas des pourcentages. Le collecteur ne lit pas les arguments de commande, les variables d’environnement, les chemins des exécutables, les fichiers ni la mémoire des processus.

## Quand le réseau tombe

Les données sont écrites dans la file locale avant d’être envoyées, et le collecteur réessaie en cas d’échec temporaire. Quand la file est pleine, les nouveaux lots sont abandonnés et le collecteur consigne la perte. Les lots plus vieux que la durée maximale sont aussi abandonnés.

Chaque file est liée à une adresse d’ingestion et à une machine inscrite. Si vous changez l’une ou l’autre, utilisez un nouveau dossier de file.

## Inscription et accès

Au premier démarrage, le collecteur crée une clé privée dans son dossier d’état et s’inscrit avec la clé d’inscription. Il apparaît ensuite sous **Nœuds** dans **Paramètres du projet → Collecteurs**, et le fichier de la clé peut être supprimé. Il renouvelle ensuite lui-même un jeton d’accès de courte durée : il n’y a rien à renouveler sur la machine.

Pour empêcher une machine d’envoyer des données, révoquez son nœud dans la page Collecteurs; l’effet est visible en 30 secondes environ. Révoquer une clé d’inscription empêche de nouvelles machines de s’inscrire, sans arrêter celles déjà inscrites. Pour inscrire de nouveau une machine révoquée ou supprimée, supprimez `node.json` et `node.key` de son dossier d’état, utilisez un nouveau dossier de file et démarrez-la avec une clé d’inscription active.

## Prochaines étapes

- [Enregistrez une exécution](/fr/docs/quick-start/#5-enregistrer-une-exécution) pour voir ce que faisait une machine.
- [Hébergez Recount vous-même](/fr/docs/self-hosting/) si vos données doivent rester sur votre réseau.
