---
title: Concepts
description: Organisations, projets, rôles, sources et exécutions.
---

## Organisations et projets

Une organisation regroupe vos projets et vos membres. Un projet délimite les données et les accès : la télémétrie, les collecteurs et les exécutions appartiennent tous à un projet. Utilisez des projets distincts pour des travaux qui n’ont rien à voir.

## Rôles

Les projets sont privés par défaut. Les propriétaires et les administrateurs de l’organisation ont un accès administrateur à tous ses projets. Les autres membres ont besoin d’un rôle dans le projet :

| Rôle           | Peut                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| Lecteur        | Voir toutes les exécutions du projet.                                            |
| Membre         | Tout ce que peut un lecteur, en plus de renommer ses propres exécutions.         |
| Administrateur | Tout, y compris les paramètres, les membres et les identifiants des collecteurs. |

## Sources et identifiants d’accès

Une source est ce qui envoie la télémétrie, habituellement un collecteur sur une machine. Chaque identifiant d’accès de collecteur inscrit une source dans un projet et détermine pour quelle machine elle peut envoyer des données.

Vous pouvez renouveler un identifiant pour obtenir un nouveau jeton, ou le révoquer pour empêcher cette source d’envoyer d’autres données. Révoquer un identifiant n’a aucun effet sur les autres. Pour changer ce qu’un identifiant permet, créez-en un nouveau et révoquez l’ancien.

## Exécutions

Une exécution est une période enregistrée sur une source, éventuellement limitée à un hôte. Toute personne qui peut lire le projet peut ouvrir toutes ses exécutions.

Une exécution ne suit pas l’état d’une tâche, en cours ou terminée. Elle enregistre la période que vous avez choisie et montre ce que faisait la machine pendant ce temps.

## Données manquantes

Recount ne comble jamais les trous. Quand une mesure manque, le graphique affiche un vide plutôt qu’un zéro. Les mesures gardent leur horodatage d’origine, même quand elles arrivent en retard.

## Prochaines étapes

- [Connectez une machine](/fr/docs/quick-start/) et enregistrez votre première exécution.
- [Configurez le collecteur](/fr/docs/collector/) pour vos machines.
