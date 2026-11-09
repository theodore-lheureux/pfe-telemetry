---
title: Démarrage rapide
description: Connectez votre première machine et enregistrez une exécution.
---

Ce guide vous mène d’un nouveau projet à votre première page d’exécution. Il vous faut une machine Linux pour faire fonctionner le collecteur.

## 1. Créer un projet

Connectez-vous et créez un projet dans votre organisation. Les propriétaires et les administrateurs de l’organisation peuvent créer des projets.

## 2. Créer un identifiant d’accès de collecteur

En tant qu’administrateur du projet, ouvrez **Paramètres du projet → Identifiants d’accès des collecteurs** et choisissez **Créer un identifiant d’accès de collecteur**.

- **Nom de l’identifiant d’accès :** ce qui vous aidera à le reconnaître plus tard.
- **ID de source :** un nom stable pour ce qui envoie les données, par exemple `build-server-1`.
- **Identifiant de la racine inscrite :** l’identité de la machine. Par défaut, le collecteur utilise `/etc/machine-id`. Exécutez `cat /etc/machine-id` sur la machine pour l’obtenir.

Choisissez **Créer l’identifiant d’accès**. Le jeton n’est affiché qu’une seule fois : enregistrez-le avant de quitter la page.

## 3. Enregistrer le jeton sur la machine

Stockez le jeton dans un fichier que seul votre utilisateur peut lire. La page de l’identifiant affiche les commandes à utiliser. Une façon de faire :

```sh
install -d -m 700 ~/.config/recount
(umask 077 && cat > ~/.config/recount/source.token)
# Collez le jeton, appuyez sur Entrée, puis sur Ctrl-D
```

Gardez le jeton hors des arguments de commande, de l’historique du terminal, des billets et des journaux.

## 4. Démarrer le collecteur

Indiquez au collecteur l’adresse d’ingestion de Recount et le fichier du jeton :

```sh
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ca.ingest.recount.cloud
export RECOUNT_COLLECTOR_SOURCE_TOKEN_FILE=~/.config/recount/source.token
recount-collector
```

C’est l’adresse de Recount Cloud. Si vous [hébergez Recount vous-même](/fr/docs/self-hosting/), utilisez plutôt votre propre adresse d’ingestion. Dans les deux cas, ce n’est pas l’adresse de l’application Web.

## 5. Enregistrer une exécution

Dans le projet, ouvrez **Exécutions** et choisissez **Enregistrer l’exécution**. Choisissez la source, éventuellement un hôte, ainsi qu’un début et une fin. Une période peut durer jusqu’à sept jours.

Ouvrez l’exécution enregistrée pour voir la télémétrie de la machine pendant cette période.

## Prochaines étapes

- [Faites fonctionner le collecteur sur chaque machine à surveiller](/fr/docs/collector/), en arrière-plan.
- [Découvrez comment s’agencent projets, rôles et exécutions](/fr/docs/concepts/).
