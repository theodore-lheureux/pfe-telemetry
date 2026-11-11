---
title: Introduction
description: Ce qu’est Recount et comment il est organisé.
---

Recount recueille la télémétrie de vos machines et la garde au même endroit. Vous enregistrez les périodes qui vous intéressent, comme une mise en production, un test ou un ralentissement, et vous y revenez plus tard pour voir ce que faisait chaque machine.

Vous pouvez utiliser **Recount Cloud**, que nous exploitons pour vous, ou [héberger Recount vous-même](/fr/docs/self-hosting/). Les deux fonctionnent de la même façon, et cette documentation s’applique aux deux.

## Comment tout s’agence

- **Organisations et projets.** Tout se trouve dans un projet. Les projets sont privés : seules les personnes que vous ajoutez peuvent les voir.
- **Collecteurs.** Un petit programme fonctionne sur chaque machine Linux et envoie la télémétrie à Recount. Chacun s’inscrit avec une clé créée dans le projet; seules les machines que vous inscrivez peuvent donc envoyer des données.
- **Exécutions.** Une exécution est une période enregistrée sur un nœud, éventuellement limitée à un hôte. En l’ouvrant, vous voyez ce que faisait la machine pendant cette période.

## Ce que vous pouvez voir aujourd’hui

La page d’une exécution affiche le temps processeur et la mémoire du nœud pour la période choisie. Le collecteur enregistre aussi des mesures de disque et par processus. Elles sont stockées, mais pas encore affichées.

Les graphiques montrent ce que faisait la machine pendant la période. Ils ne prouvent pas qu’une tâche précise a causé cette activité, et deux exécutions qui se chevauchent peuvent montrer les mêmes données.

## Prochaines étapes

- [Démarrage rapide](/fr/docs/quick-start/) : connectez votre première machine.
- [Concepts](/fr/docs/concepts/) : projets, rôles, sources et exécutions.
- [Collecteur](/fr/docs/collector/) : référence de configuration.
