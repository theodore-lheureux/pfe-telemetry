---
title: Concepts
description: Organisations, projets, rôles, sources et exécutions.
---

## Organisations et projets

Une organisation regroupe vos projets et vos membres. Un projet délimite les données et les accès : la télémétrie, les collecteurs et les exécutions appartiennent tous à un projet. Utilisez des projets distincts pour des travaux qui n’ont rien à voir.

## Rôles

Les projets sont privés par défaut. Les propriétaires et les administrateurs de l’organisation ont un accès administrateur à tous ses projets. Les autres membres ont besoin d’un rôle dans le projet :

| Rôle           | Peut                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| Lecteur        | Voir toutes les exécutions du projet.                                    |
| Membre         | Tout ce que peut un lecteur, en plus de renommer ses propres exécutions. |
| Administrateur | Tout, y compris les paramètres, les membres et les collecteurs.          |

## Nœuds et clés d’inscription

Un nœud est une machine qui envoie de la télémétrie à un projet, par le collecteur qui y fonctionne. Les machines s’inscrivent d’elles-mêmes avec une clé d’inscription créée dans le projet : une seule clé suffit pour ajouter tout un parc.

Révoquer un nœud empêche cette machine d’envoyer d’autres données, sans effet sur les autres. Révoquer une clé d’inscription empêche de nouvelles machines de s’inscrire avec elle; les machines déjà inscrites continuent d’envoyer leurs données.

## Exécutions

Une exécution est une période enregistrée sur un nœud, éventuellement limitée à un hôte. Toute personne qui peut lire le projet peut ouvrir toutes ses exécutions.

Une exécution ne suit pas l’état d’une tâche, en cours ou terminée. Elle enregistre la période que vous avez choisie et montre ce que faisait la machine pendant ce temps.

## Données manquantes

Recount ne comble jamais les trous. Quand une mesure manque, le graphique affiche un vide plutôt qu’un zéro. Les mesures gardent leur horodatage d’origine, même quand elles arrivent en retard.

## Prochaines étapes

- [Connectez une machine](/fr/docs/quick-start/) et enregistrez votre première exécution.
- [Configurez le collecteur](/fr/docs/collector/) pour vos machines.
