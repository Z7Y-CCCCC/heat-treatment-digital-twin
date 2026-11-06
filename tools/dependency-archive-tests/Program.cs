// Only the same headless extractor compiled into the two shipping native hosts.
return HeatTreatment.Shared.DependencyArchive.TryRun(args, out var exitCode) ? exitCode : 2;
