---
title: Auto-hébergement
description: Exécuter Recount sur vos propres serveurs.
---

Vous pouvez exécuter Recount sur votre propre infrastructure plutôt que d’utiliser Recount Cloud. C’est le même produit, et votre télémétrie ne quitte jamais votre réseau.

:::note
Des versions prêtes pour l’auto-hébergement s’en viennent. Cette page couvrira l’installation et les mises à jour dès qu’elles seront disponibles.
:::

## Ce que vous exécutez

Une installation de Recount comporte trois parties :

- **L’application Web**, où votre équipe se connecte, gère les projets et consulte les moments enregistrés.
- **Le service d’ingestion**, qui reçoit la télémétrie de vos collecteurs. Vos machines doivent pouvoir le joindre sur le réseau.
- **Le stockage**, qui conserve vos comptes, vos projets et votre télémétrie.

Chaque partie fonctionne dans un conteneur; vous pouvez donc utiliser les outils que vous avez déjà pour exécuter et surveiller vos services.

## Connecter les collecteurs

Les collecteurs fonctionnent comme avec Recount Cloud. En suivant le [démarrage rapide](/fr/docs/quick-start/), indiquez au collecteur votre propre adresse d’ingestion plutôt que celle de l’infonuagique.

## Infonuagique ou auto-hébergé?

- **Recount Cloud** est la façon la plus rapide de commencer. Il n’y a rien à installer ni à entretenir.
- **L’auto-hébergement** convient aux équipes dont les données doivent rester sur leur réseau, ou qui exploitent déjà leurs propres services.

## Prochaines étapes

- [Suivez le démarrage rapide](/fr/docs/quick-start/) avec votre propre adresse d’ingestion.
- [Lisez sur les projets et les rôles](/fr/docs/concepts/) avant d’inviter votre équipe.
