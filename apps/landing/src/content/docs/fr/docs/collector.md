---
title: Collecteur
description: Configurer le collecteur Linux.
---

`recount-collector` échantillonne les ressources du nœud et des processus Linux à partir de `/proc` et les envoie à Recount. Il fonctionne uniquement sous Linux.

## Configuration

Les paramètres sont lus une seule fois au démarrage. Les options de ligne de commande ont priorité sur les variables d’environnement; exécutez `recount-collector --help` pour connaître leurs noms.

| Variable                                  | Par défaut                     | Signification                                                               |
| ----------------------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`             | `http://127.0.0.1:14317`       | Adresse d’ingestion de Recount.                                             |
| `RECOUNT_COLLECTOR_SOURCE_TOKEN_FILE`     | Aucune                         | Chemin du fichier privé qui contient le jeton de l’identifiant d’accès.     |
| `RECOUNT_COLLECTOR_INTERVAL_MS`           | `1000`                         | Période d’échantillonnage, de 100 à 60000 ms.                               |
| `RECOUNT_COLLECTOR_HOST_ID`               | `/etc/machine-id`              | Identité de la machine. Doit correspondre à l’ID racine de l’identifiant.   |
| `RECOUNT_COLLECTOR_VISIBILITY`            | `restricted`                   | Mettez `host` seulement si le collecteur voit les processus de l’hôte.      |
| `RECOUNT_COLLECTOR_PROCESS_NAMESPACE_ID`  | `host` avec la visibilité hôte | Identité de l’espace de noms des PID. Obligatoire en visibilité restreinte. |
| `RECOUNT_COLLECTOR_QUEUE_DIRECTORY`       | `.state/collector-queue`       | Dossier local des données en attente d’envoi. Un collecteur par dossier.    |
| `RECOUNT_COLLECTOR_QUEUE_MAX_BYTES`       | `67108864`                     | Quantité maximale de données en file, de 1 Mio à 1 Gio.                     |
| `RECOUNT_COLLECTOR_QUEUE_MAX_BATCHES`     | `1024`                         | Nombre maximal de lots en attente.                                          |
| `RECOUNT_COLLECTOR_QUEUE_MAX_AGE_SECONDS` | `3600`                         | Durée d’attente maximale d’un lot avant qu’il soit abandonné.               |
| `RUST_LOG`                                | `info`                         | Niveau de journalisation.                                                   |

Tout changement de paramètre exige un redémarrage.

## Ce qu’il recueille

- **Nœud :** temps processeur, mémoire totale et disponible, E/S disque.
- **Processus :** temps processeur, mémoire résidente, E/S disque.

Les valeurs de processeur et de disque sont des totaux cumulés, pas des pourcentages. Le collecteur ne lit pas les arguments de commande, les variables d’environnement, les chemins des exécutables, les fichiers ni la mémoire des processus.

## Quand le réseau tombe

Les données sont écrites dans la file locale avant d’être envoyées, et le collecteur réessaie en cas d’échec temporaire. Quand la file est pleine, les nouveaux lots sont abandonnés et le collecteur consigne la perte. Les lots plus vieux que la durée maximale sont aussi abandonnés.

Chaque file est liée à une adresse d’ingestion et à un jeton. Si vous changez l’un ou l’autre, utilisez un nouveau dossier de file.

## Renouveler un jeton

1. Arrêtez le collecteur pendant que l’ancien jeton est encore valide.
2. Exécutez `recount-collector --drain` avec l’ancien jeton pour envoyer ce qui reste en file.
3. Renouvelez l’identifiant et remplacez le fichier du jeton.
4. Redémarrez le collecteur avec un nouveau dossier de file.
