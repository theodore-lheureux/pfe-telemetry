---
title: Démarrage rapide
description: Connectez votre première machine et enregistrez une exécution.
---

Ce guide vous mène d’un nouveau projet à votre première page d’exécution. Il vous faut une machine Linux pour faire fonctionner le collecteur.

## 1. Créer un projet

Connectez-vous et créez un projet dans votre organisation. Les propriétaires et les administrateurs de l’organisation peuvent créer des projets.

## 2. Créer une clé d’inscription

En tant qu’administrateur du projet, ouvrez **Paramètres du projet → Collecteurs** et choisissez **Créer une clé d’inscription**. Donnez-lui un nom, par exemple `build-servers`, puis choisissez **Créer une clé d’inscription**.

La clé n’est affichée qu’une seule fois : enregistrez-la avant de fermer la fenêtre. Une seule clé peut inscrire toutes les machines d’un parc.

## 3. Enregistrer la clé sur la machine

Stockez la clé dans un fichier que seul votre utilisateur peut lire :

```sh
install -d -m 700 ~/.config/recount
(umask 077 && cat > ~/.config/recount/enrollment.key)
# Collez la clé, appuyez sur Entrée, puis sur Ctrl-D
```

Gardez la clé hors des arguments de commande, de l’historique du terminal, des billets et des journaux.

## 4. Démarrer le collecteur

Indiquez au collecteur l’application Web de Recount, qui inscrit la machine, et l’adresse d’ingestion, qui reçoit sa télémétrie :

```sh
export RECOUNT_COLLECTOR_ENROLLMENT_URL=https://votre-application-recount.example
export RECOUNT_COLLECTOR_ENROLLMENT_KEY_FILE=~/.config/recount/enrollment.key
export RECOUNT_COLLECTOR_STATE_DIRECTORY=~/.local/state/recount
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ca.ingest.recount.cloud
recount-collector
```

Utilisez comme adresse d’inscription celle où vous vous connectez. L’adresse d’ingestion indiquée est celle de Recount Cloud; si vous [hébergez Recount vous-même](/fr/docs/self-hosting/), utilisez la vôtre. Au premier démarrage, la machine s’inscrit d’elle-même et apparaît sous **Nœuds** dans la page Collecteurs.

## 5. Enregistrer une exécution

Dans le projet, ouvrez **Exécutions** et choisissez **Enregistrer l’exécution**. Choisissez le nœud, éventuellement un hôte, ainsi qu’un début et une fin. Une période peut durer jusqu’à sept jours.

Ouvrez l’exécution enregistrée pour voir la télémétrie de la machine pendant cette période.

## Prochaines étapes

- [Faites fonctionner le collecteur sur chaque machine à surveiller](/fr/docs/collector/), en arrière-plan.
- [Découvrez comment s’agencent projets, rôles et exécutions](/fr/docs/concepts/).
